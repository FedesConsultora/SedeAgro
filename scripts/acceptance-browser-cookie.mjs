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
  assert.equal(logoutResponse.status(), 200, await logoutResponse.text());
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
  const anonymous = await page1.evaluate(async () =>
    (await fetch('/api/v1/auth/me', { credentials: 'include' })).status);
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
