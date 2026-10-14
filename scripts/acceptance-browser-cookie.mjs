// End-to-end cookie login/logout and remote revocation against a REAL
// Express/PostgreSQL backend and actual React app in Chromium. Disposable DB only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import pg from 'pg';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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
async function waitUntil(url) {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch { /* start pending */ }
    await new Promise((r) => setTimeout(r, 175));
  }
  throw new Error('Timed out waiting for ' + url);
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

  // Second independent browser context signs in to the same tenant.
  const context2 = await browser.newContext();
  const page2 = await context2.newPage();
  await page2.goto('http://127.0.0.1:4177/');
  await page2.locator('#login-email').fill(email);
  await page2.locator('#login-password').fill(password);
  await page2.locator('#login-submit').click();
  await page2.getByRole('button', { name: 'Sesiones' }).waitFor();
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

  await page1.getByRole('navigation', { name: 'Principal' })
    .getByRole('button', { name: 'Cerrar sesión' }).click();
  await page1.getByRole('heading', { name: 'Iniciar sesión' }).waitFor();
  assert.equal((await context1.cookies()).some((item) => item.name === 'sedeagro_session'), false);
  console.log('PASS: UI logout clears HttpOnly cookie and returns to login');
  await context2.close();
  await context1.close();
} finally {
  if (browser) await browser.close();
  if (vite) vite.kill();
  if (backend) backend.kill();
  if (tenantId) await admin.query('DELETE FROM tenants WHERE id = $1', [tenantId]).catch(() => {});
  if (userId) await admin.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
  await admin.end().catch(() => {});
}
