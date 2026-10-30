// End-to-end cookie login/logout and remote revocation against a REAL
// Express/PostgreSQL backend and actual React app in Chromium. Disposable DB only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import pg from 'pg';
import { chromium } from 'playwright';
import { assertDialogFocus, pressReverseTabAtDialogRoot } from './support/assert-dialog-focus.mjs';
import { getFocusStressCycles } from './support/focus-stress-config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const focusCycles = getFocusStressCycles();
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const appUrl = process.env.TEST_DATABASE_APP_URL;
if (!adminUrl || !appUrl || !/[_-]test(?:[_-]|$)/i.test(new URL(adminUrl).pathname)) {
  throw new Error('Browser session acceptance requires the disposable *_test database.');
}

function start(cwd, argv, moreEnv = {}) {
  const child = spawn(process.execPath, argv, {
    cwd: resolve(root, cwd),
    env: { ...process.env, ...moreEnv }, stdio: 'ignore'
  });
  return child;
}
async function stopService(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 4000))]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}
async function waitUntil(url) {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch { /* start pending */ }
    await new Promise((r) => setTimeout(r, 175));
  }
  throw new Error('Timed out waiting for ' + url);
}
// Inspect only whether the optional encrypted identity envelope still exists.
// Never expose ciphertext, decrypted actor IDs or local passphrases in logs.
async function hasOfflineFieldEnvelope(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('sedeagro-field-offline-vault', 1);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('offline-vault', { keyPath: 'id' });
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('offline-vault', 'readonly');
      let sealed = false;
      const row = tx.objectStore('offline-vault').get('active');
      row.onsuccess = () => {
        sealed = row.result?.ciphertext instanceof ArrayBuffer &&
          row.result?.iv?.length === 12 && row.result?.salt?.length === 16;
      };
      tx.oncomplete = () => { db.close(); resolve(sealed); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  }));
}

async function prepareOfflineFieldEnvelope(page) {
  await page.getByRole('button', { name: 'Sync', exact: true }).click();
  await page.getByRole('heading', { name: 'Preparar recuperación sin conexión' }).waitFor();
  await page.getByLabel('Frase local (no es tu contraseña del servidor)')
    .fill('Browser field recovery phrase 2026!');
  await page.getByRole('button', { name: 'Habilitar acceso offline (48 h)' }).click();
  await page.getByText('Acceso local preparado para 48 horas.', { exact: false }).waitFor();
  assert.equal(await hasOfflineFieldEnvelope(page), true,
    'an opt-in recovery envelope must be durably committed before revocation testing');
}

const random = randomUUID().replaceAll('-', '').slice(0, 12);
const email = `browser-${random}@example.test`;
const slug = `browser-session-${random}`;
const password = 'StrongBrowser-Pilot-2026!';
const admin = new pg.Client({ connectionString: adminUrl });
let tenantId;
let userId;
let backend;
let vite;
let browser;
try {
  await admin.connect();
  const { rows: [{ database }] } = await admin.query('SELECT current_database() AS database');
  if (!/[_-]test(?:[_-]|$)/i.test(database)) throw new Error('Refusing non-test database');
  backend = start('backend', ['src/server.js'], {
    PORT: '3001', DATABASE_URL: appUrl, NODE_ENV: 'test',
    CORS_ORIGIN: 'http://127.0.0.1:4177',
    JWT_SECRET: 'not-for-production-rls-integration-only'
  });
  await waitUntil('http://127.0.0.1:3001/health');
  vite = start('frontend', [resolve(root, 'node_modules/vite/bin/vite.js'),
    '--host', '127.0.0.1', '--port', '4177', '--strictPort']);
  await waitUntil('http://127.0.0.1:4177/');

  browser = await chromium.launch({ headless: true });
  const context1 = await browser.newContext();
  const page1 = await context1.newPage();
  await page1.goto('http://127.0.0.1:4177/');
  await page1.getByRole('button', { name: 'Crear cuenta nueva' }).click();
  await page1.locator('#reg-org-name').fill('Browser Cookie Pilot');
  await page1.locator('#reg-slug').fill(slug);
  await page1.locator('#reg-full-name').fill('Browser Test Owner');
  await page1.locator('#reg-email').fill(email);
  await page1.locator('#reg-password').fill(password);
  const registered = page1.waitForResponse((res) => res.url().endsWith('/auth/register-tenant') &&
    res.request().method() === 'POST');
  await page1.locator('#register-submit').click();
  const registration = await registered;
  assert.equal(registration.status(), 201, await registration.text());
  const registrationBody = await registration.json();
  assert.equal(registrationBody.token, undefined);
  tenantId = registrationBody.tenant.id;
  userId = registrationBody.user.id;
  await page1.getByRole('button', { name: 'Sesiones' }).waitFor();
  const cookie = (await context1.cookies()).find((item) => item.name === 'sedeagro_session');
  assert.ok(cookie?.httpOnly);
  assert.equal(cookie.sameSite, 'Strict');
  assert.equal(await page1.evaluate(() => localStorage.getItem('sedeagro.session')), null);
  assert.equal(await page1.evaluate(() => localStorage.getItem('sedeagro.tenantHint')), tenantId);
  console.log('PASS: real React registration sets HttpOnly cookie without storing JWT');

  await page1.reload();
  await page1.getByRole('button', { name: 'Sesiones' }).waitFor();
  await page1.getByRole('button', { name: 'Sesiones' }).click();
  await page1.getByText('Esta sesión').waitFor();
  console.log('PASS: browser restores cookie session and renders current device');

  // P1 #211 — The server COMMIT may succeed while the HTTP ACK never reaches
  // the browser. Run the actual Campaigns UI against real Express/PostGIS,
  // drop ONLY the transport acknowledgment AFTER route.fetch receives 201,
  // reload the whole SPA and require a conscious replay of the same UUID.
  const campaignName = 'Lost ACK campaign ' + random;
  let committedCampaignId = null;
  let firstCampaignRequestId = null;
  let lostAckCount = 0;
  await page1.getByRole('button', { name: 'Campañas', exact: true }).click();
  await page1.getByRole('button', { name: 'Nueva campaña' }).click();
  const pendingCampaignDialog = page1.getByRole('dialog', { name: 'Nueva campaña' });
  await pendingCampaignDialog.getByText('Comprobando envíos pendientes cifrados…').waitFor({ state: 'hidden' });
  await pendingCampaignDialog.locator('#campaign-name').fill(campaignName);
  await pendingCampaignDialog.locator('#campaign-year').fill('2026');
  await pendingCampaignDialog.locator('#campaign-starts').fill('2026-09-01');
  await pendingCampaignDialog.locator('#campaign-ends').fill('2027-04-30');
  await page1.route('**/api/v1/campaigns', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    lostAckCount++;
    const posted = route.request().postDataJSON();
    firstCampaignRequestId = posted.client_request_id;
    assert.match(firstCampaignRequestId || '', /^[a-f0-9-]{36}$/i);
    const realResponse = await route.fetch();
    assert.equal(realResponse.status(), 201, await realResponse.text());
    const realBody = await realResponse.json();
    assert.equal(realBody.replayed, false);
    assert.equal(realBody.data.tenant_id, tenantId);
    committedCampaignId = realBody.data.id;
    // The backend has really COMMITted; intentionally lose the ACK. No mock
    // response and no retry are issued by the browser automation here.
    await route.abort('failed');
  });
  await pendingCampaignDialog.getByRole('button', { name: 'Crear campaña' }).click();
  await pendingCampaignDialog.getByText('No pudimos confirmar la campaña.', {
    exact: false
  }).waitFor();
  assert.equal(lostAckCount, 1, 'double click / transport error must not auto-resubmit');
  assert.ok(committedCampaignId && firstCampaignRequestId);
  assert.equal(await pendingCampaignDialog.getByRole('button', { name: 'Confirmación pendiente' }).isDisabled(), true);
  const countBeforeRetry = (await admin.query(
    'SELECT count(*)::int AS n FROM campaigns WHERE tenant_id=$1 AND name=$2',
    [tenantId, campaignName])).rows[0].n;
  assert.equal(countBeforeRetry, 1, 'the real server committed even though its browser ACK was lost');
  const pendingBeforeReload = await page1.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open('sedeagro-campaign-recovery', 1);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('pending-creates', 'readonly');
      const records = tx.objectStore('pending-creates').getAll();
      records.onerror = () => reject(records.error);
      records.onsuccess = () => {
        const rows = records.result;
        db.close();
        resolve(rows.map(row => ({
          id: row.id, sealed: row.ciphertext instanceof ArrayBuffer,
          ivLength: row.iv?.length, hasPlainName: JSON.stringify(row).includes('Lost ACK campaign')
        })));
      };
    };
  }));
  assert.equal(pendingBeforeReload.length, 1, 'one encrypted pending request must survive ACK loss');
  assert.equal(pendingBeforeReload[0].id, firstCampaignRequestId);
  assert.equal(pendingBeforeReload[0].sealed, true);
  assert.equal(pendingBeforeReload[0].ivLength, 12);
  assert.equal(pendingBeforeReload[0].hasPlainName, false);
  await page1.unroute('**/api/v1/campaigns');

  // Full tab reload proves the journal is durable, not merely a React ref.
  await page1.reload();
  await page1.getByRole('button', { name: 'Campañas', exact: true }).click();
  await page1.getByRole('button', { name: 'Nueva campaña' }).click();
  const recoveryCampaignDialog = page1.getByRole('dialog', { name: 'Nueva campaña' });
  await recoveryCampaignDialog.getByText('Hay una creación pendiente de confirmar.', {
    exact: false
  }).waitFor();
  assert.equal(await recoveryCampaignDialog.locator('#campaign-name').inputValue(), campaignName);
  assert.equal(await recoveryCampaignDialog.locator('#campaign-name').isDisabled(), true);
  assert.equal(await recoveryCampaignDialog.getByRole('button', { name: 'Confirmación pendiente' }).isDisabled(), true);
  let replayCount = 0;
  await page1.route('**/api/v1/campaigns', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    replayCount++;
    const posted = route.request().postDataJSON();
    assert.equal(posted.client_request_id, firstCampaignRequestId);
    assert.equal(posted.name, campaignName);
    const actual = await route.fetch();
    assert.equal(actual.status(), 200, await actual.text());
    const receipt = await actual.json();
    assert.equal(receipt.replayed, true);
    assert.equal(receipt.data.id, committedCampaignId);
    await route.fulfill({ response: actual });
  });
  await recoveryCampaignDialog.getByRole('button', {
    name: 'Reintentar el mismo envío'
  }).click();
  await recoveryCampaignDialog.waitFor({ state: 'detached' });
  assert.equal(replayCount, 1, 'restoration must issue one explicit same-key POST only');
  const confirmedCampaign = page1.getByRole('button', {
    name: 'Campaña ' + campaignName + ', mostrar lotes'
  });
  await confirmedCampaign.waitFor();
  assert.equal(await confirmedCampaign.count(), 1, 'list contains one campaign, never a duplicate');
  assert.equal((await admin.query(
    'SELECT count(*)::int AS n FROM campaigns WHERE tenant_id=$1 AND name=$2',
    [tenantId, campaignName])).rows[0].n, 1);
  const remainingJournal = await page1.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open('sedeagro-campaign-recovery', 1);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('pending-creates', 'readonly');
      const count = tx.objectStore('pending-creates').count();
      count.onsuccess = () => { db.close(); resolve(count.result); };
      count.onerror = () => { db.close(); reject(count.error); };
    };
  }));
  assert.equal(remainingJournal, 0, 'verified same-key ACK retires pending local ciphertext');
  await page1.unroute('**/api/v1/campaigns');
  console.log('PASS: lost campaign ACK after real PostGIS COMMIT, sealed journal survives reload, same-key 200 replay and exactly one campaign');

  // P0 #222: Complete the live people-onboarding UI rather than relying on
  // SQL-only fixtures or mock cards. The recipient is a separate cookie-free
  // browser context and must accept the one-time code and log in personally.
  await page1.getByRole('button', { name: 'Equipos', exact: true }).click();
  const invitations = page1.getByRole('region', { name: 'Invitaciones a esta empresa' });
  await invitations.getByRole('heading', { name: 'Invitar colaboradores' }).waitFor();
  const scoutName = 'Pilot Invited Scout';
  const scoutEmail = `scout-${random}@example.test`;
  const scoutPassword = 'Pilot-Invite-Scout-Password-2026!';
  const teamName = 'Equipo operativo piloto';
  await invitations.getByRole('textbox', { name: 'Email del destinatario' }).fill(scoutEmail);
  const inviteAck = page1.waitForResponse(res =>
    res.url().endsWith('/auth/invitations') && res.request().method() === 'POST');
  await invitations.getByRole('button', { name: 'Generar invitación' }).click();
  assert.equal((await inviteAck).status(), 201, 'real invitation must be created server-side');
  await invitations.getByText('Invitación generada (todavía no enviada)').waitFor();
  const secret = (await invitations.locator('code').textContent())?.trim() || '';
  assert.match(secret, /^[0-9a-f-]{36}\.[a-f0-9]{64}$/i);
  assert.equal(secret.slice(0, 36).toLowerCase(), tenantId.toLowerCase());
  // No email, token or one-time invitation secret is written to the test log.
  const inviteContext = await browser.newContext();
  try {
    const recipient = await inviteContext.newPage();
    await recipient.goto('http://127.0.0.1:4177/');
    assert.equal((await inviteContext.cookies()).some(c => c.name === 'sedeagro_session'), false);
    await recipient.getByRole('button', { name: 'Tengo una invitación' }).click();
    await recipient.getByLabel('Código privado de invitación').fill(secret);
    await recipient.getByLabel('Nombre completo (solo si todavía no tenés cuenta)').fill(scoutName);
    await recipient.locator('input[type="password"]').fill(scoutPassword);
    const activationAck = recipient.waitForResponse(res =>
      res.url().endsWith('/auth/invite/accept') && res.request().method() === 'POST');
    await recipient.getByRole('button', { name: 'Activar mi acceso' }).click();
    assert.equal((await activationAck).status(), 201, 'first invitation acceptance must succeed');
    await recipient.getByText('se activó.', { exact: false }).waitFor();
    await recipient.getByRole('button', { name: 'Ir a iniciar sesión' }).click();
    await recipient.locator('#login-email').fill(scoutEmail);
    await recipient.locator('#login-password').fill(scoutPassword);
    const firstLogin = recipient.waitForResponse(res =>
      res.url().endsWith('/auth/login') && res.request().method() === 'POST');
    await recipient.locator('#login-submit').click();
    const loginReply = await firstLogin;
    assert.equal(loginReply.status(), 200);
    const newActor = await loginReply.json();
    assert.equal(newActor.tenant.id, tenantId);
    assert.equal(newActor.membership.roleCode, 'scout');
    await recipient.getByRole('button', { name: 'Sesiones' }).waitFor();
  } finally {
    await inviteContext.close();
  }

  // The admin is STILL in TeamPage: a second-device acceptance cannot be
  // inferred from a cached list. Explicit refresh must obtain fresh scoped
  // members, teams and invitation statuses without resubmitting the invite.
  await page1.getByRole('button', { name: 'Actualizar equipo' }).click();
  await invitations.getByText('Aceptada', { exact: false }).waitFor();
  await page1.getByText(scoutName, { exact: true }).waitFor();
  const createTeam = page1.getByRole('form', { name: 'Crear equipo de trabajo' });
  await createTeam.getByRole('textbox', { name: 'Nombre del equipo' }).fill(teamName);
  const teamAck = page1.waitForResponse(res =>
    res.url().endsWith('/teams') && res.request().method() === 'POST');
  await createTeam.getByRole('button', { name: 'Crear equipo' }).click();
  assert.equal((await teamAck).status(), 201);
  const addMember = page1.getByRole('form', { name: 'Agregar integrante a un equipo' });
  await addMember.waitFor();
  await addMember.getByRole('combobox', { name: 'Equipo', exact: true })
    .selectOption({ label: teamName });
  await addMember.getByRole('combobox', { name: 'Integrante activo' })
    .selectOption({ label: `${scoutName} (${scoutEmail})` });
  const memberAck = page1.waitForResponse(res =>
    /\/teams\/[0-9a-f-]{36}\/members$/.test(new URL(res.url()).pathname) &&
    res.request().method() === 'POST');
  await addMember.getByRole('button', { name: 'Agregar integrante' }).click();
  assert.equal((await memberAck).status(), 201);
  await page1.locator('.team-tile').filter({ hasText: teamName })
    .getByText(scoutName, { exact: true }).waitFor();
  console.log('PASS: real admin invite -> independent recipient activation/login -> scoped refresh -> team assignment');


  // 0T.1: real authenticated portal; keyboard must remain inside the modal,
  // Escape must close it, and focus must return to the invoking control.
  await page1.getByRole('button', { name: 'Establecimientos' }).click();
  const farmOpener = page1.locator('.workspace-heading').getByRole('button', { name: 'Nuevo establecimiento' });
  const farmDialog = page1.getByRole('dialog', { name: 'Nuevo establecimiento' });
  // Repeated open/close cycles catch asynchronous focus races that a single
  // successful run could miss. Every cycle uses real producer API results.
  for (let cycle = 1; cycle <= focusCycles; cycle += 1) {
    await farmOpener.click();
    await farmDialog.waitFor();
    // Crear starts disabled while the producer lookup is pending. Wait for
    // actual API-backed form readiness, never for an arbitrary timeout.
    await farmDialog.getByRole('button', { name: 'Crear', exact: true })
      .waitFor({ state: 'visible' });
    await page1.waitForFunction(() => {
      const dialog = [...document.querySelectorAll('[role="dialog"]')]
        .find(node => node.getAttribute('aria-labelledby') &&
          node.textContent.includes('Nuevo establecimiento'));
      const create = dialog && [...dialog.querySelectorAll('button')]
        .find(node => node.textContent.trim() === 'Crear');
      return Boolean(create && !create.disabled);
    }, null, { timeout: 10000 });
    await assertDialogFocus(page1, farmDialog, farmDialog, 'farm-ready-root-' + cycle);
    // Capture the actually enabled last control at keydown, not at an
    // earlier lookup-ready observation (the async form may still rerender).
    await pressReverseTabAtDialogRoot(page1, farmDialog,
      'farm-ready-last-' + cycle);
    await page1.keyboard.press('Tab');
    await assertDialogFocus(page1, farmDialog,
      farmDialog.getByRole('button', { name: 'Cerrar Nuevo establecimiento' }),
      'farm-ready-first-' + cycle);
    await page1.keyboard.press('Escape');
    await farmDialog.waitFor({ state: 'detached' });
    await assertDialogFocus(page1, page1.locator('body'), farmOpener,
      'farm-ready-return-' + cycle);
    console.log('PASS: Chromium farm modal focus loop ' + cycle + '/' + focusCycles);
  }

  // Force a genuine in-flight HTTP lookup to remain pending while keyboard
  // navigation executes. No artificial sleeps: the transport is released by
  // the test only AFTER asserting disabled control, reverse/forward focus,
  // and the active dialog. Then assert focus still stays inside after React
  // enables Crear and mounts optional producer choices.
  let releaseProducerLookup;
  const holdProducerLookup = new Promise(resolve => { releaseProducerLookup = resolve; });
  const requestStarted = page1.waitForRequest(
    request => request.url().includes('/api/v1/farms/producers') && request.method() === 'GET',
    { timeout: 10000 }
  );
  await page1.route('**/api/v1/farms/producers', async route => {
    await holdProducerLookup;
    await route.continue();
  });
  try {
    await farmOpener.click();
    await requestStarted;
    await farmDialog.getByText('Cargando productores autorizados…').waitFor();
    assert.equal(await farmDialog.getByRole('button', { name: 'Crear', exact: true }).isDisabled(), true,
      'Crear must not become keyboard-enabled before the real API resolves');
    await assertDialogFocus(page1, farmDialog, farmDialog, 'farm-pending-root');
    await pressReverseTabAtDialogRoot(page1, farmDialog, 'farm-pending-last');
    await assertDialogFocus(page1, farmDialog,
      farmDialog.getByRole('button', { name: 'Cancelar' }), 'farm-pending-cancel');
    await page1.keyboard.press('Tab');
    const pendingClose = farmDialog.getByRole('button', { name: 'Cerrar Nuevo establecimiento' });
    await assertDialogFocus(page1, farmDialog, pendingClose, 'farm-pending-first');
    releaseProducerLookup();
    await page1.waitForFunction(() => {
      const dialog = [...document.querySelectorAll('[role="dialog"]')]
        .find(node => node.textContent.includes('Nuevo establecimiento'));
      const create = dialog && [...dialog.querySelectorAll('button')]
        .find(node => node.textContent.trim() === 'Crear');
      return Boolean(create && !create.disabled);
    }, null, { timeout: 10000 });
    await assertDialogFocus(page1, farmDialog, pendingClose,
      'farm-after-lookup-retains-first');
    await page1.keyboard.press('Shift+Tab');
    await assertDialogFocus(page1, farmDialog,
      farmDialog.getByRole('button', { name: 'Crear', exact: true }),
      'farm-after-lookup-new-last');
    await page1.keyboard.press('Escape');
    await farmDialog.waitFor({ state: 'detached' });
    await assertDialogFocus(page1, page1.locator('body'), farmOpener,
      'farm-after-lookup-restored-opener');
    console.log('PASS: Chromium focus remains trapped through held HTTP loading -> ready transition');
  } finally {
    releaseProducerLookup();
    await page1.unroute('**/api/v1/farms/producers');
  }

  // An actual live lookup failure must not silently insert demo producer IDs
  // into a create form. Retry is explicit and a failed lookup blocks submit.
  await page1.route('**/api/v1/farms/producers', route => route.fulfill({
    status: 503, contentType: 'application/json',
    body: JSON.stringify({ error: { message: 'Consulta de productores interrumpida' } })
  }));
  await farmOpener.click();
  await farmDialog.getByText('No se pudieron cargar productores.').waitFor();
  assert.equal(await farmDialog.getByRole('button', { name: 'Crear', exact: true }).isDisabled(), true);
  assert.equal(await farmDialog.locator('#farm-producer option').count(), 0);
  await assertDialogFocus(page1, farmDialog, farmDialog, 'farm-error-root');
  await page1.keyboard.press('Shift+Tab');
  // Disabled Crear MUST be skipped; the last tabbable element is Cancelar.
  await assertDialogFocus(page1, farmDialog,
    farmDialog.getByRole('button', { name: 'Cancelar' }), 'farm-error-last-enabled');
  await page1.keyboard.press('Tab');
  await assertDialogFocus(page1, farmDialog,
    farmDialog.getByRole('button', { name: 'Cerrar Nuevo establecimiento' }),
    'farm-error-first');
  await page1.unroute('**/api/v1/farms/producers');
  await farmDialog.getByRole('button', { name: 'Reintentar' }).click();
  await page1.waitForFunction(() => {
    const button = [...document.querySelectorAll('[role="dialog"] button')]
      .find(node => node.textContent.trim() === 'Crear');
    return Boolean(button && !button.disabled);
  });
  await farmDialog.locator('#farm-name').fill('Fixture Accesibilidad 0T1');
  await farmDialog.getByRole('button', { name: 'Crear', exact: true }).click();
  await farmDialog.waitFor({ state: 'detached' });
  await page1.getByRole('button', { name: /Establecimiento Fixture Accesibilidad 0T1, mostrar lotes/ }).waitFor();
  const farmToggle = page1.locator('.farm-card__toggle').filter({ hasText: 'Fixture Accesibilidad 0T1' });
  await farmToggle.press('Space');
  assert.equal(await farmToggle.getAttribute('aria-expanded'), 'true');
  console.log('PASS: live farm form never falls back to mock producer list');
  await page1.getByRole('button', { name: 'Sesiones' }).click();
  await page1.getByText('Esta sesión').waitFor();



  // TOP-inspired operational landing must fail visibly when an API resource
  // fails, never hydrate unrelated demo orders or a fabricated field score.
  await page1.route('**/api/v1/work-orders', (route) => route.fulfill({
    status: 503, contentType: 'application/json',
    body: JSON.stringify({ error: { message: 'Recurso temporalmente no disponible' } })
  }));
  await page1.getByRole('button', { name: 'Inicio' }).click();
  await page1.getByText(/Parte de la información no se pudo consultar/).waitFor();
  const homeText = await page1.locator('main').innerText();
  assert.ok(homeText.includes('Órdenes'));
  assert.ok(!homeText.includes('Aplicacion selectiva lote 4'),
    'live API failure must never show mock orders');
  assert.ok(!homeText.includes('Mock fallback'));
  await page1.unroute('**/api/v1/work-orders');
  await page1.getByRole('button', { name: 'Ver órdenes' }).click();
  await page1.getByRole('heading', { name: 'Órdenes de trabajo' }).waitFor();
  await page1.route('**/api/v1/fields', route => route.fulfill({
    status: 503, contentType: 'application/json',
    body: JSON.stringify({ error: { message: 'Consulta de lotes interrumpida' } })
  }));
  await page1.getByRole('button', { name: 'Nueva orden' }).click();
  const orderDialog = page1.getByRole('dialog', { name: 'Nueva orden de trabajo' });
  await orderDialog.getByText('No se pudieron cargar lotes de la orden.').waitFor();
  assert.equal(await orderDialog.getByRole('button', { name: 'Crear orden' }).isDisabled(), true);
  assert.equal(await orderDialog.locator('#wo-field option').count(), 1,
    'no private or fake field choices after lookup fails');
  await assertDialogFocus(page1, orderDialog, orderDialog, 'order-error-root');
  await page1.keyboard.press('Shift+Tab');
  await assertDialogFocus(page1, orderDialog,
    orderDialog.getByRole('button', { name: 'Cancelar' }), 'order-error-last-enabled');
  await page1.keyboard.press('Tab');
  await assertDialogFocus(page1, orderDialog,
    orderDialog.getByRole('button', { name: 'Cerrar Nueva orden de trabajo' }),
    'order-error-first');
  await page1.keyboard.press('Escape');
  await orderDialog.waitFor({ state: 'detached' });
  await assertDialogFocus(page1, page1.locator('body'),
    page1.getByRole('button', { name: 'Nueva orden' }), 'order-error-return');
  await page1.unroute('**/api/v1/fields');
  console.log('PASS: live order form blocks creation when field lookup fails');

  await page1.getByRole('button', { name: 'Sesiones' }).click();
  await page1.getByText('Esta sesión').waitFor();
  console.log('PASS: operational home surfaces partial failure and opens real orders without mock fallback');

  // Other operational modules must also fail honestly: never replace a live
  // transport failure with example farms or campaigns.
  await page1.route('**/api/v1/farms', (route) => route.fulfill({
    status: 503, contentType: 'application/json',
    body: JSON.stringify({ error: { message: 'Consulta de establecimientos interrumpida' } })
  }));
  await page1.getByRole('button', { name: 'Establecimientos' }).click();
  await page1.getByText('No se pudieron cargar establecimientos.').waitFor();
  assert.equal(await page1.getByText('La Esperanza', { exact: true }).count(), 0);
  await page1.unroute('**/api/v1/farms');

  await page1.route('**/api/v1/campaigns', (route) => route.fulfill({
    status: 503, contentType: 'application/json',
    body: JSON.stringify({ error: { message: 'Consulta de campañas interrumpida' } })
  }));
  await page1.getByRole('button', { name: 'Campañas' }).click();
  await page1.getByText('No se pudieron cargar campañas.').waitFor();
  assert.equal(await page1.getByText('Campaña gruesa 2026/27').count(), 0);
  await page1.unroute('**/api/v1/campaigns');
  await page1.getByRole('button', { name: 'Sesiones' }).click();
  await page1.getByText('Esta sesión').waitFor();
  console.log('PASS: farms and campaigns reject live mock fallback after API 503');

  // Prepare a REAL opt-in local recovery envelope for the current active
  // admin account, before proving server logout with a blocked IDB deletion.
  await prepareOfflineFieldEnvelope(page1);
  await page1.getByRole('button', { name: 'Sesiones' }).click();
  await page1.getByText('Esta sesión').waitFor();
  console.log('PASS: real /auth/me enrollment persists encrypted vault before logout');

  // MOB-05 cross-tab: TWO pages in the SAME BrowserContext share origin and
  // IndexedDB. An obsolete clear has already claimed its origin-wide nonce,
  // but is blocked before IDB.open. The second tab re-enrolls using a genuine
  // server-verified /auth/me; releasing the old clear MUST keep the new row.
  await page1.evaluate(async () => {
    const originalOpen = indexedDB.open.bind(indexedDB);
    window.__vaultOpenHeld = false;
    window.__vaultReleaseOpen = null;
    window.__vaultOpenOriginal = originalOpen;
    let holdNext = true;
    indexedDB.open = (name, version) => {
      if (name !== 'sedeagro-field-offline-vault' || !holdNext)
        return originalOpen(name, version);
      holdNext = false;
      const fake = { result: null, error: null, onsuccess: null,
        onupgradeneeded: null, onerror: null, onblocked: null };
      window.__vaultOpenHeld = true;
      window.__vaultReleaseOpen = () => {
        const req = originalOpen(name, version);
        req.onupgradeneeded = event => {
          fake.result = req.result;
          fake.onupgradeneeded?.(event);
        };
        req.onerror = () => { fake.error = req.error; fake.onerror?.(); };
        req.onblocked = event => fake.onblocked?.(event);
        req.onsuccess = () => {
          fake.result = req.result;
          fake.onsuccess?.();
        };
      };
      return fake;
    };
    const { clearOfflineFieldVault } = await import('/src/services/offlineFieldVault.js');
    window.__vaultOldClear = clearOfflineFieldVault();
  });
  assert.equal(await page1.evaluate(() => window.__vaultOpenHeld), true);
  const sameOriginTab = await context1.newPage();
  try {
    await sameOriginTab.goto('http://127.0.0.1:4177/');
    await sameOriginTab.getByRole('button', { name: 'Sesiones' }).waitFor();
    await sameOriginTab.evaluate(async id => {
      const response = await fetch('/api/v1/auth/me', {
        credentials: 'include', headers: { 'x-tenant-id': id }
      });
      if (response.status !== 200) throw new Error('real server identity required');
      const profile = await response.json();
      if (profile?.tenant?.id !== id) throw new Error('wrong real server tenant');
      const { enrollOfflineFieldVault } = await import('/src/services/offlineFieldVault.js');
      await enrollOfflineFieldVault({ ...profile, authenticated: true },
        'Browser field recovery phrase 2026!');
    }, tenantId);
    const readIv = async () => sameOriginTab.evaluate(() => new Promise((resolve, reject) => {
      const req = indexedDB.open('sedeagro-field-offline-vault', 1);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('offline-vault', 'readonly');
        const row = tx.objectStore('offline-vault').get('active');
        row.onsuccess = () => {
          const iv = row.result?.iv;
          db.close();
          resolve(Array.isArray(iv) ? iv.join(',') : null);
        };
        row.onerror = () => { db.close(); reject(row.error); };
      };
    }));
    const currentIv = await readIv();
    assert.ok(currentIv, 'independent second tab must persist a new sealed envelope');
    await page1.evaluate(async () => {
      window.__vaultReleaseOpen();
      try { await window.__vaultOldClear; }
      finally { indexedDB.open = window.__vaultOpenOriginal; }
    });
    assert.equal(await readIv(), currentIv,
      'superseded first-tab deletion must not erase second-tab committed vault');
    assert.equal(await hasOfflineFieldEnvelope(page1), true);
    console.log('PASS: real same-origin Chromium tabs fence stale clear against newer encrypted vault');
  } finally {
    await sameOriginTab.close();
    await page1.evaluate(() => {
      if (window.__vaultOpenOriginal) indexedDB.open = window.__vaultOpenOriginal;
      delete window.__vaultReleaseOpen;
      delete window.__vaultOldClear;
    });
  }

  // Second independent browser context signs in to the same tenant.
  const context2 = await browser.newContext();
  const page2 = await context2.newPage();
  await page2.goto('http://127.0.0.1:4177/');
  await page2.locator('#login-email').fill(email);
  await page2.locator('#login-password').fill(password);
  await page2.locator('#login-submit').click();
  await page2.getByRole('button', { name: 'Sesiones' }).waitFor();
  // Second active browser prepares its OWN encrypted offline envelope; remote
  // revocation must clean it when a real authenticated API call returns 401.
  await prepareOfflineFieldEnvelope(page2);
  await page2.getByRole('button', { name: 'Sesiones' }).click();
  await page2.getByText('Esta sesión').waitFor();

  await page1.getByRole('button', { name: 'Actualizar' }).click();
  await page1.getByText('Otra sesión activa').waitFor();

  page1.once('dialog', (dialog) => dialog.accept());
  await page1.getByText('Otra sesión activa').locator('xpath=../../..')
    .getByRole('button', { name: 'Cerrar sesión' }).click();
  await page1.getByText('Se revocó la sesión seleccionada').waitFor();
  const revoked = await page2.evaluate(async (id) => {
    const res = await fetch('/api/v1/auth/me', {
      credentials: 'include', headers: { 'x-tenant-id': id }
    });
    return res.status;
  }, tenantId);
  assert.equal(revoked, 401);
  console.log('PASS: UI remote revocation immediately invalidates other browser cookie');

  const expiredResponse = page2.waitForResponse((res) =>
    res.url().endsWith('/auth/sessions') && res.status() === 401);
  await page2.getByRole('button', { name: 'Actualizar' }).click();
  await expiredResponse;
  await page2.getByRole('heading', { name: 'Iniciar sesión' }).waitFor();
  await page2.waitForFunction(async () => {
    const request = indexedDB.open('sedeagro-field-offline-vault', 1);
    return new Promise((resolve) => {
      request.onupgradeneeded = () =>
        request.result.createObjectStore('offline-vault', { keyPath: 'id' });
      request.onerror = () => resolve(false);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('offline-vault', 'readonly');
        const row = tx.objectStore('offline-vault').get('active');
        let erased = false;
        row.onsuccess = () => { erased = row.result === undefined; };
        tx.oncomplete = () => { db.close(); resolve(erased); };
        tx.onerror = () => { db.close(); resolve(false); };
      };
    });
  }, null, { timeout: 10000 });
  assert.equal(await hasOfflineFieldEnvelope(page2), false);
  assert.equal(await page2.evaluate(() => localStorage.getItem('sedeagro.tenantHint')), null);
  const rejectedAfterRevocation = await page2.evaluate(async (id) =>
    (await fetch('/api/v1/auth/me', {
      credentials: 'include', headers: { 'x-tenant-id': id }
    })).status, tenantId);
  assert.equal(rejectedAfterRevocation, 401,
    'a revoked HttpOnly cookie may remain in the browser but must not authorize backend access');
  console.log('PASS: real revoked 401 retires the offline vault and hides private React views');

  // Simulate a real IndexedDB deletion rejection ONLY for the vault store,
  // without intercepting /auth/logout or changing its server response.
  await page1.evaluate(() => {
    const originalDelete = IDBObjectStore.prototype.delete;
    window.__vaultDeleteBlocked = false;
    IDBObjectStore.prototype.delete = function (key) {
      if (this.name === 'offline-vault' && key === 'active') {
        window.__vaultDeleteBlocked = true;
        throw new DOMException('Synthetic local deletion error', 'UnknownError');
      }
      return originalDelete.call(this, key);
    };
  });
  const logoutAck = page1.waitForResponse(res =>
    res.url().endsWith('/auth/logout') && res.request().method() === 'POST');

  await page1.getByRole('navigation', { name: 'Principal' })
    .getByRole('button', { name: 'Cerrar sesión' }).click();
  const logoutResponse = await logoutAck;
  assert.equal(logoutResponse.status(), 204, await logoutResponse.text());
  await page1.getByRole('heading', { name: 'Iniciar sesión' }).waitFor();
  assert.equal(await page1.evaluate(() => window.__vaultDeleteBlocked), true,
    'the IndexedDB failure branch must really have executed');
  await page1.getByText('Se cerró la sesión del servidor, pero no se pudo borrar el acceso offline local.', {
    exact: false
  }).waitFor();
  assert.equal(await hasOfflineFieldEnvelope(page1), true,
    'the encrypted envelope may survive failed deletion and requires device cleanup');
  assert.equal(await page1.evaluate(() => localStorage.getItem('sedeagro.tenantHint')), null);
  assert.equal((await context1.cookies()).some((item) => item.name === 'sedeagro_session'), false);
  const anonymous = await page1.evaluate(async (id) =>
    (await fetch('/api/v1/auth/me', {
      credentials: 'include', headers: { 'x-tenant-id': id }
    })).status, tenantId);
  assert.equal(anonymous, 401, 'server session must remain revoked after local IDB failure');
  console.log('PASS: confirmed server logout hides private views and warns when vault IDB deletion fails');
  await context2.close();
  await context1.close();
} finally {
  if (browser) await browser.close();
  await stopService(vite);
  await stopService(backend);
  if (tenantId) await admin.query('DELETE FROM tenants WHERE id = $1', [tenantId]).catch(() => {});
  if (userId) await admin.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
  await admin.end().catch(() => {});
}
