// End-to-end cookie login/logout and remote revocation against a REAL
// Express/PostgreSQL backend and actual React app in Chromium. Disposable DB only.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import pg from 'pg';
import { chromium } from 'playwright';
import { assertDialogFocus, pressReverseTabAtDialogRoot } from './support/assert-dialog-focus.mjs';
import { getFocusStressCycles } from './support/focus-stress-config.mjs';
import { assertSealedPendingCreate, assertNoPendingCreate } from './support/assert-create-journal-sealed.mjs';
import { attachTestCameraJpeg, inspectSealedFieldDraft, SOURCE_GPS_EXIF_SENTINEL } from './support/assert-sealed-field-capture.mjs';

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
  await page1.locator('.sidebar__item[title="Campañas"]').click();
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
  await page1.locator('.sidebar__item[title="Campañas"]').click();
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

  // Prepare the actual farm -> field -> campaign-field path with authenticated
  // application HTTP; do not inject rows behind the runtime RLS policy.
  const farmId = (await admin.query(
    'SELECT id FROM farms WHERE tenant_id=$1 AND name=$2',
    [tenantId, 'Fixture Accesibilidad 0T1'])).rows[0]?.id;
  const cropId = (await admin.query(
    "SELECT id FROM crop_types WHERE code='soy'")).rows[0]?.id;
  assert.ok(farmId && cropId && committedCampaignId);
  const fieldName = 'Lote piloto ACK ' + random;
  const fieldId = await page1.evaluate(async fixture => {
    const response = await fetch('/api/v1/fields', {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-tenant-id': fixture.tenantId,
        'x-sedeagro-request': '1' },
      body: JSON.stringify({ farm_id: fixture.farmId, name: fixture.fieldName,
        area_hectares: 14.75, status: 'active' })
    });
    const result = await response.json();
    if (response.status !== 201) throw new Error('Real field API rejected pilot setup: ' +
      response.status + ' ' + JSON.stringify(result.error));
    return result.data.id;
  }, { tenantId, farmId, fieldName });
  assert.match(fieldId, /^[a-f0-9-]{36}$/i);
  const campaignFieldId = await page1.evaluate(async fixture => {
    const response = await fetch('/api/v1/campaigns/' + fixture.campaignId + '/fields', {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-tenant-id': fixture.tenantId,
        'x-sedeagro-request': '1' },
      body: JSON.stringify({ field_id: fixture.fieldId,
        crop_type_id: fixture.cropId, status: 'planned' })
    });
    const result = await response.json();
    if (response.status !== 201) throw new Error('Real campaign-field API rejected pilot setup: ' +
      response.status + ' ' + JSON.stringify(result.error));
    return result.data.id;
  }, { tenantId, campaignId: committedCampaignId, fieldId, cropId });
  assert.match(campaignFieldId, /^[a-f0-9-]{36}$/i);

  // P1 #204: the real Orders modal persists one AES-GCM request before POST.
  // Express commits 201, but Chromium does NOT receive that ACK.
  const orderTitle = 'Orden ACK perdido ' + random;
  let committedOrderId = null;
  let orderRequestId = null;
  let orderFirstPosts = 0;
  await page1.locator('.sidebar__item[title="Órdenes"]').click();
  await page1.getByRole('heading', { name: 'Órdenes de trabajo' }).waitFor();
  await page1.getByRole('button', { name: 'Nueva orden' }).click();
  const lostOrderDialog = page1.getByRole('dialog', { name: 'Nueva orden de trabajo' });
  await lostOrderDialog.locator('#wo-field').selectOption(fieldId);
  await lostOrderDialog.locator('#wo-title').fill(orderTitle);
  await lostOrderDialog.locator('#wo-instructions').fill('Control de campo con acuse ambiguo');
  await page1.route('**/api/v1/work-orders', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    orderFirstPosts++;
    const authored = route.request().postDataJSON();
    orderRequestId = authored.client_request_id;
    assert.match(orderRequestId || '', /^[a-f0-9-]{36}$/i);
    assert.equal(authored.field_id, fieldId);
    assert.equal(authored.title, orderTitle);
    const response = await route.fetch();
    assert.equal(response.status(), 201, await response.text());
    const receipt = await response.json();
    assert.equal(receipt.replayed, false);
    assert.equal(receipt.data.tenant_id, tenantId);
    committedOrderId = receipt.data.id;
    await route.abort('failed');
  });
  await lostOrderDialog.getByRole('button', { name: 'Crear orden' }).click();
  await lostOrderDialog.getByText('No pudimos confirmar la orden.', { exact: false }).waitFor();
  assert.equal(orderFirstPosts, 1, 'lost ACK must not cause silent resend');
  assert.ok(orderRequestId && committedOrderId);
  assert.equal(await lostOrderDialog.getByRole('button', {
    name: 'Confirmación pendiente'
  }).isDisabled(), true);
  assert.equal((await admin.query(
    'SELECT count(*)::int AS n FROM work_orders WHERE tenant_id=$1 AND title=$2',
    [tenantId, orderTitle])).rows[0].n, 1, 'real order COMMIT happened before ACK loss');
  await assertSealedPendingCreate(page1, 'sedeagro-work-order-recovery',
    orderRequestId, orderTitle);
  await page1.unroute('**/api/v1/work-orders');

  await page1.reload();
  await page1.locator('.sidebar__item[title="Órdenes"]').click();
  await page1.getByRole('button', { name: 'Nueva orden' }).click();
  const retryOrderDialog = page1.getByRole('dialog', { name: 'Nueva orden de trabajo' });
  await retryOrderDialog.getByText('Hay una orden pendiente de confirmar.', {
    exact: false
  }).waitFor();
  assert.equal(await retryOrderDialog.locator('#wo-title').inputValue(), orderTitle);
  assert.equal(await retryOrderDialog.locator('#wo-title').isDisabled(), true);
  assert.equal(await retryOrderDialog.getByRole('button', {
    name: 'Confirmación pendiente'
  }).isDisabled(), true);
  let orderReplays = 0;
  await page1.route('**/api/v1/work-orders', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    orderReplays++;
    const authored = route.request().postDataJSON();
    assert.equal(authored.client_request_id, orderRequestId);
    assert.equal(authored.title, orderTitle);
    assert.equal(authored.field_id, fieldId);
    const response = await route.fetch();
    assert.equal(response.status(), 200, await response.text());
    const receipt = await response.json();
    assert.equal(receipt.replayed, true);
    assert.equal(receipt.data.id, committedOrderId);
    await route.fulfill({ response });
  });
  await retryOrderDialog.getByRole('button', { name: 'Reintentar el mismo envío' }).click();
  await retryOrderDialog.waitFor({ state: 'detached' });
  assert.equal(orderReplays, 1);
  await page1.getByRole('button', { name: 'Abrir orden: ' + orderTitle }).waitFor();
  assert.equal(await page1.getByRole('button', {
    name: 'Abrir orden: ' + orderTitle
  }).count(), 1);
  assert.equal((await admin.query(
    'SELECT count(*)::int AS n FROM work_orders WHERE tenant_id=$1 AND title=$2',
    [tenantId, orderTitle])).rows[0].n, 1);
  await assertNoPendingCreate(page1, 'sedeagro-work-order-recovery');
  await page1.unroute('**/api/v1/work-orders');
  console.log('PASS: real work-order COMMIT lost ACK, encrypted recovery reload, exact-key 200 replay, one order');

  // P1 #207: same contract for a field scouting run, including the unique
  // audit event and assigned scout's notification. Use a genuine invited
  // actor and live campaign-field rather than an unscoped fixture.
  const scoutUserId = (await admin.query(
    'SELECT id FROM users WHERE email=$1', [scoutEmail])).rows[0]?.id;
  assert.ok(scoutUserId, 'invited scout must exist in real tenant');
  const runSummary = 'Recorrida ACK perdido ' + random;
  let committedRunId = null;
  let runRequestId = null;
  let runFirstPosts = 0;
  await page1.locator('.sidebar__item[title="Monitoreo"]').click();
  await page1.getByRole('heading', { name: 'Monitoreo' }).waitFor();
  await page1.getByRole('button', { name: 'Nueva recorrida' }).click();
  const lostRunDialog = page1.getByRole('dialog', { name: 'Nueva recorrida de monitoreo' });
  await lostRunDialog.locator('select').nth(0).selectOption(campaignFieldId);
  await lostRunDialog.locator('select').nth(1).selectOption(scoutUserId);
  await lostRunDialog.locator('textarea').fill(runSummary);
  await page1.route('**/api/v1/scouting/runs', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    runFirstPosts++;
    const authored = route.request().postDataJSON();
    runRequestId = authored.client_request_id;
    assert.match(runRequestId || '', /^[a-f0-9-]{36}$/i);
    assert.equal(authored.campaign_field_id, campaignFieldId);
    assert.equal(authored.assigned_to, scoutUserId);
    assert.equal(authored.summary, runSummary);
    const response = await route.fetch();
    assert.equal(response.status(), 201, await response.text());
    const receipt = await response.json();
    assert.equal(receipt.replayed, false);
    assert.equal(receipt.data.tenant_id, tenantId);
    committedRunId = receipt.data.id;
    await route.abort('failed');
  });
  await lostRunDialog.getByRole('button', { name: 'Crear recorrida' }).click();
  await lostRunDialog.getByText('No pudimos confirmar la creación.', {
    exact: false
  }).waitFor();
  assert.equal(runFirstPosts, 1, 'lost run ACK must not be resent automatically');
  assert.ok(runRequestId && committedRunId);
  assert.equal(await lostRunDialog.getByRole('button', {
    name: 'Confirmación pendiente'
  }).isDisabled(), true);
  const runArtifactCounts = async () => (await admin.query(
    'SELECT ' +
    '(SELECT count(*)::int FROM scouting_runs WHERE tenant_id=$1 AND campaign_field_id=$2 AND summary=$3) AS runs, ' +
    "(SELECT count(*)::int FROM audit_events WHERE tenant_id=$1 AND entity_id=$4 AND action='scouting.run.created') AS audits, " +
    "(SELECT count(*)::int FROM notifications WHERE tenant_id=$1 AND entity_id=$4 AND entity_type='scouting_run') AS notices",
    [tenantId, campaignFieldId, runSummary, committedRunId])).rows[0];
  assert.deepEqual(await runArtifactCounts(), {
    runs: 1, audits: 1, notices: 1
  }, 'first real run commit generated exactly one audit and assignment notification');
  await assertSealedPendingCreate(page1, 'sedeagro-scouting-run-recovery',
    runRequestId, runSummary);
  await page1.unroute('**/api/v1/scouting/runs');

  await page1.reload();
  await page1.locator('.sidebar__item[title="Monitoreo"]').click();
  await page1.getByRole('button', { name: 'Nueva recorrida' }).click();
  const retryRunDialog = page1.getByRole('dialog', { name: 'Nueva recorrida de monitoreo' });
  await retryRunDialog.getByText('Hay una recorrida pendiente de confirmar.', {
    exact: false
  }).waitFor();
  assert.equal(await retryRunDialog.locator('textarea').inputValue(), runSummary);
  assert.equal(await retryRunDialog.locator('textarea').isDisabled(), true);
  assert.equal(await retryRunDialog.getByRole('button', {
    name: 'Confirmación pendiente'
  }).isDisabled(), true);
  let runReplays = 0;
  await page1.route('**/api/v1/scouting/runs', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    runReplays++;
    const authored = route.request().postDataJSON();
    assert.equal(authored.client_request_id, runRequestId);
    assert.equal(authored.campaign_field_id, campaignFieldId);
    assert.equal(authored.assigned_to, scoutUserId);
    assert.equal(authored.summary, runSummary);
    const response = await route.fetch();
    assert.equal(response.status(), 200, await response.text());
    const receipt = await response.json();
    assert.equal(receipt.replayed, true);
    assert.equal(receipt.data.id, committedRunId);
    await route.fulfill({ response });
  });
  await retryRunDialog.getByRole('button', {
    name: 'Reintentar el mismo envío (sin duplicar)'
  }).click();
  await retryRunDialog.waitFor({ state: 'detached' });
  assert.equal(runReplays, 1, 'run recovery must use one explicit original-key POST');
  await page1.locator('.scouting-workspace__table button.data-table__row')
    .filter({ hasText: fieldName }).first().waitFor();
  assert.equal(await page1.locator('.scouting-workspace__table button.data-table__row')
    .filter({ hasText: fieldName }).count(), 1);
  assert.deepEqual(await runArtifactCounts(), { runs: 1, audits: 1, notices: 1 },
    'replay cannot duplicate a run or its tenant-scoped side effects');
  await assertNoPendingCreate(page1, 'sedeagro-scouting-run-recovery');
  await page1.unroute('**/api/v1/scouting/runs');
  console.log('PASS: real scouting COMMIT lost ACK, sealed reload and same-key replay; audit and notification exactly once');

  // #163/#166 field pilot: real UI + a genuine offline network interruption.
  // Camera and coordinates are accepted ONLY after an explicit opt-in.
  const fieldObservationNote = 'Foto GPS real capturada sin internet ' + random;
  const fieldPoint = { type: 'Point', coordinates: [-57.95453, -34.92145] };
  await context1.grantPermissions(['geolocation'], { origin: 'http://127.0.0.1:4177' });
  await context1.setGeolocation({ longitude: fieldPoint.coordinates[0],
    latitude: fieldPoint.coordinates[1], accuracy: 11 });
  const runRow = page1.locator('.scouting-workspace__table button.data-table__row')
    .filter({ hasText: fieldName }).first();
  await runRow.click();
  await page1.getByRole('button', { name: 'Agregar observación' }).click();
  const fieldCaptureDialog = page1.getByRole('dialog', { name: 'Agregar observación' });
  await fieldCaptureDialog.locator('#obs-type').selectOption('pest');
  await fieldCaptureDialog.locator('#obs-severity').selectOption('high');
  await fieldCaptureDialog.locator('#obs-notes').fill(fieldObservationNote);
  await context1.setOffline(true);
  await fieldCaptureDialog.getByRole('button', { name: 'Usar ubicación actual' }).click();
  await fieldCaptureDialog.getByText('Ubicación lista para adjuntar').waitFor();
  const cameraFixture = await attachTestCameraJpeg(page1);
  assert.ok(cameraFixture.size > 64, 'real Canvas JPEG must be created');
  await fieldCaptureDialog.getByText(cameraFixture.name).waitFor();
  await fieldCaptureDialog.getByRole('button', { name: 'Guardar observación' }).click();
  await page1.getByText('Observación guardada en este dispositivo.', {
    exact: false
  }).waitFor();
  const encryptedCaptureId = await inspectSealedFieldDraft(page1, {
    note: fieldObservationNote, point: fieldPoint
  });
  assert.equal((await admin.query(
    'SELECT count(*)::int AS n FROM scouting_observations WHERE tenant_id=$1 AND scouting_run_id=$2 AND notes=$3',
    [tenantId, committedRunId, fieldObservationNote])).rows[0].n, 0,
  'no network: real backend must not have received the local observation');
  console.log('PASS: offline real React observation opt-in GPS + Camera File, AES-GCM IndexedDB, zero server writes');

  // An online signal does not constitute a confirmed server receipt.
  // Force one transport interruption during reconnection; keep the stable
  // encrypted batch and its separate photo until explicit recovery after reload.
  let preventedAutomaticBatches = 0;
  await page1.route('**/api/v1/sync/batches', route => {
    if (route.request().method() !== 'POST') return route.continue();
    preventedAutomaticBatches++;
    return route.abort('failed');
  });
  await context1.setOffline(false);
  await page1.reload();
  await page1.getByRole('button', { name: 'Sesiones' }).waitFor();
  const reopenedCaptureId = await inspectSealedFieldDraft(page1, {
    note: fieldObservationNote, point: fieldPoint, scopeId: encryptedCaptureId
  });
  assert.equal(reopenedCaptureId, encryptedCaptureId,
    'full app reload must preserve same encrypted batch UUID');
  assert.equal((await admin.query(
    'SELECT count(*)::int AS n FROM scouting_observations WHERE tenant_id=$1 AND scouting_run_id=$2 AND notes=$3',
    [tenantId, committedRunId, fieldObservationNote])).rows[0].n, 0);
  await page1.unroute('**/api/v1/sync/batches');
  console.log('PASS: reconnect transport interruption + full SPA reload preserve exact AES-GCM GPS/photo draft');

  // Actual SyncPage performs BOTH the observation batch and independently
  // verified private photo upload; the queue may retire only after both.
  await page1.getByRole('button', { name: 'Sync', exact: true }).click();
  await page1.getByRole('heading', { name: 'Sincronizaciones' }).waitFor();
  await page1.getByText('Foto local: campo-ubicacion-privada-reducida.jpg', {
    exact: false
  }).waitFor();
  const photoReply = page1.waitForResponse(response =>
    /\/api\/v1\/scouting\/observations\/[0-9a-f-]{36}\/evidence$/.test(
      new URL(response.url()).pathname) && response.request().method() === 'POST',
    { timeout: 60000 }).catch(() => null);
  const batchPredicate = response =>
    response.url().endsWith('/api/v1/sync/batches') &&
    response.request().method() === 'POST';
  let batchResponse = null;
  // On reconnect, the app may still own the same account-scoped Web Lock
  // while its blocked automatic flush is finishing. The UI surfaces "busy".
  // Only in that exact visible case may the operator explicitly press again.
  for (let attempt = 0; attempt < 3 && !batchResponse; attempt++) {
    const reply = page1.waitForResponse(batchPredicate, { timeout: 6500 })
      .catch(() => null);
    await page1.getByRole('button', { name: 'Enviar solo esta' }).click();
    batchResponse = await reply;
    if (!batchResponse) {
      const busy = await page1.getByText(
        'Otra pestaña está procesando esta cuenta. Probá nuevamente.', {
          exact: false
        }).count();
      assert.equal(busy, 1,
        'no POST was dispatched: the app must explicitly report a scope-lock skip');
    }
  }
  assert.ok(batchResponse?.ok(), 'real PostGIS sync batch must be accepted');
  const batchResult = await batchResponse.json();
  assert.equal(batchResult.data.status, 'processed');
  const photoResponse = await photoReply;
  assert.ok(photoResponse, 'real private-photo upload ACK must arrive');
  assert.equal(photoResponse.status(), 201, await photoResponse.text());
  const photoResult = await photoResponse.json();
  assert.equal(photoResult.replayed, false);
  const persistedObservationId = batchResult.data.operations[0].result.observation_id;
  const persistedEvidenceId = photoResult.data.id;
  assert.equal(photoResult.data.scouting_observation_id, persistedObservationId);
  await page1.getByText('No hay observaciones pendientes.', {
    exact: false
  }).waitFor();
  console.log('PASS: SyncPage actual batch and private photo POST both confirmed before encrypted draft retirement');

  // One committed WGS84 point + one private attachment, with no source
  // camera EXIF/GPS marker ever crossing the HTTP or persistence boundary.
  const [savedLocation] = (await admin.query(
    'SELECT id, ST_X(point)::float8 AS longitude, ST_Y(point)::float8 AS latitude, observed_by ' +
    'FROM scouting_observations WHERE tenant_id=$1 AND scouting_run_id=$2 AND notes=$3',
    [tenantId, committedRunId, fieldObservationNote])).rows;
  assert.equal(savedLocation?.id, persistedObservationId);
  assert.equal(savedLocation?.observed_by, userId);
  assert.equal(savedLocation.longitude, fieldPoint.coordinates[0]);
  assert.equal(savedLocation.latitude, fieldPoint.coordinates[1]);
  const [privatePhoto] = (await admin.query(
    'SELECT id, scouting_observation_id, uploaded_by, original_name, mime_type, size_bytes, content_sha256 ' +
    'FROM evidence_assets WHERE tenant_id=$1 AND scouting_observation_id=$2',
    [tenantId, persistedObservationId])).rows;
  assert.equal(privatePhoto?.id, persistedEvidenceId);
  assert.equal(privatePhoto?.uploaded_by, userId);
  assert.equal(privatePhoto?.mime_type, 'image/jpeg');
  assert.equal(privatePhoto?.original_name, 'campo-ubicacion-privada-reducida.jpg');
  assert.ok(privatePhoto?.size_bytes > 64 && privatePhoto.size_bytes <= 512 * 1024);
  assert.equal((await admin.query(
    "SELECT count(*)::int AS n FROM audit_events WHERE tenant_id=$1 AND entity_id=$2 AND action='scouting.observation.synced'",
    [tenantId, persistedObservationId])).rows[0].n, 0,
  'audit entry for sync is run-scoped, not modeled as observation entity');

  const realPhoto = await page1.evaluate(async ({ evidenceId, tenant }) => {
    const result = await fetch('/api/v1/scouting/evidence/' + evidenceId + '/content', {
      credentials: 'include', headers: { 'x-tenant-id': tenant }
    });
    if (result.status !== 200) throw new Error('Private file HTTP integrity/authorization failed: ' + result.status);
    return result.json();
  }, { evidenceId: persistedEvidenceId, tenant: tenantId });
  assert.equal(realPhoto.data.id, persistedEvidenceId);
  assert.equal(realPhoto.data.mime_type, 'image/jpeg');
  const jpeg = Buffer.from(realPhoto.data.content_base64, 'base64');
  assert.equal(jpeg.byteLength, privatePhoto.size_bytes);
  assert.deepEqual([...jpeg.subarray(0, 3)], [255, 216, 255]);
  assert.equal(jpeg.includes(Buffer.from(SOURCE_GPS_EXIF_SENTINEL)), false,
    'source photo GPS/EXIF metadata must be removed before encryption/upload');
  assert.equal(createHash('sha256').update(jpeg).digest('hex'), privatePhoto.content_sha256,
    'downloaded private bytes must match persisted SHA-256');
  const anonymousContext = await browser.newContext();
  try {
    const refused = await anonymousContext.request.get(
      'http://127.0.0.1:4177/api/v1/scouting/evidence/' +
      persistedEvidenceId + '/content',
      { headers: { 'x-tenant-id': tenantId } });
    assert.ok([401, 403, 404].includes(refused.status()),
      'same-origin URL and asset UUID without valid cookie must not leak photo');
    assert.notEqual(refused.status(), 200);
  } finally { await anonymousContext.close(); }
  assert.equal((await admin.query(
    'SELECT count(*)::int AS n FROM sync_batches WHERE tenant_id=$1 AND submitted_by=$2 AND idempotency_key=$3',
    [tenantId, userId, batchResult.data.idempotency_key])).rows[0].n, 1);
  assert.equal((await admin.query(
    'SELECT count(*)::int AS n FROM evidence_assets WHERE tenant_id=$1 AND scouting_observation_id=$2',
    [tenantId, persistedObservationId])).rows[0].n, 1);
  console.log('PASS: PostGIS true GPS point, exactly-once observation/photo and private JPEG SHA-256; source EXIF stripped and anonymous download denied');
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
