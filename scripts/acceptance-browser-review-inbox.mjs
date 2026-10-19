// 0T.18 — real Chromium + Express + PostgreSQL review inbox acceptance.
// Every successful response comes from the real API over a disposable *_test DB.
// Rejected cursor is modified in transit and verified by Express (no fake 422).
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
if (!adminUrl || !appUrl || !/[_-]test(?:[_-]|$)/i.test(new URL(adminUrl).pathname) ||
    !/[_-]test(?:[_-]|$)/i.test(new URL(appUrl).pathname)) {
  throw new Error('Review inbox browser acceptance requires disposable *_test databases.');
}
const start = (cwd, args, extra = {}) => spawn(process.execPath, args, {
  cwd: resolve(root, cwd), env: { ...process.env, ...extra }, stdio: 'ignore'
});
async function waitUntil(url) {
  for (let n = 0; n < 120; n++) {
    try { if ((await fetch(url)).status < 500) return; }
    catch { /* server boot */ }
    await new Promise(resolve => setTimeout(resolve, 175));
  }
  throw new Error('Test server did not start: ' + url);
}
const token = randomUUID().replaceAll('-', '').slice(0, 12);
const password = 'Strong-Review-Browser-CI-2026!';
const admin = new pg.Client({ connectionString: adminUrl });
let backend;
let vite;
let browser;
const created = [];
async function register(page, prefix) {
  await page.getByRole('button', { name: 'Crear cuenta nueva' }).click();
  await page.locator('#reg-org-name').fill(prefix + ' Organization');
  await page.locator('#reg-slug').fill(prefix.toLowerCase().replaceAll(' ', '-') + '-' + token);
  await page.locator('#reg-full-name').fill(prefix + ' Coordinator');
  await page.locator('#reg-email').fill(prefix.toLowerCase().replaceAll(' ', '-') + '-' + token + '@example.test');
  await page.locator('#reg-password').fill(password);
  const request = page.waitForResponse(res => res.url().endsWith('/auth/register-tenant') &&
    res.request().method() === 'POST');
  await page.locator('#register-submit').click();
  const registered = await request;
  assert.equal(registered.status(), 201, await registered.text());
  const body = await registered.json();
  assert.equal(body.token, undefined, 'Never return readable browser credentials');
  created.push({ tenantId: body.tenant.id, userId: body.user.id });
  await page.getByRole('button', { name: 'Sesiones' }).waitFor();
  await admin.query(`
    INSERT INTO tenant_modules (tenant_id,module_code,is_enabled,source)
    VALUES ($1,'work_orders',true,'override'),($1,'gis',true,'override')
    ON CONFLICT (tenant_id,module_code) DO UPDATE SET
      is_enabled=true,source='override'
  `, [body.tenant.id]);
  // A real /auth/me refresh obtains the module entitlement; not a client-side fake.
  await page.reload();
  await page.getByRole('button', { name: 'Sesiones' }).waitFor();
  await page.getByTitle('Órdenes').waitFor();
  return body;
}
async function openInbox(page) {
  await page.getByTitle('Órdenes').click();
  await page.getByRole('heading', { name: 'Órdenes de trabajo' }).waitFor();
  const region = page.getByRole('region', { name: 'Pendientes de coordinación' });
  await region.getByText(/Página 1\. \d+ órdenes en esta página/).waitFor();
  return region;
}
async function pageCount(region, expected, pageNumber) {
  await region.getByText('Página ' + pageNumber + '. ' +
    expected + ' órdenes en esta página.').waitFor();
  assert.equal(await region.getByRole('button',
    { name: 'Abrir orden y comprobar' }).count(), expected);
  assert.equal(await region.getAttribute('aria-busy'), 'false');
}
async function headingFocused(page, region) {
  await page.waitForFunction(() => {
    const heading = document.getElementById('review-inbox-title');
    return Boolean(heading && document.activeElement === heading);
  });
  assert.equal(await region.getByRole('heading', { name: 'Pendientes de coordinación' })
    .evaluate(el => el === document.activeElement), true);
}
try {
  await admin.connect();
  const { rows: [{ database }] } = await admin.query('SELECT current_database() AS database');
  if (!/[_-]test(?:[_-]|$)/i.test(database)) throw new Error('Refusing non-test DB');

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
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.goto('http://127.0.0.1:4177/');
  const ownerA = await register(page, 'Queue Browser A');

  // A real PostGIS-backed tenant has 61 orders, not a fabricated success body.
  const farm = (await admin.query(
    'INSERT INTO farms(tenant_id,name) VALUES ($1,$2) RETURNING id',
    [ownerA.tenant.id, 'Review Browser Farm'])).rows[0].id;
  const field = (await admin.query(
    'INSERT INTO fields(tenant_id,farm_id,name) VALUES ($1,$2,$3) RETURNING id',
    [ownerA.tenant.id, farm, 'Review Browser Field'])).rows[0].id;
  const fixtures = (await admin.query(`
    INSERT INTO work_orders
      (tenant_id,field_id,requested_by,type,status,title,created_at)
    SELECT $1,$2,$3,'inspection','in_progress','Real review browser ' || LPAD(g::text, 3, '0'),
      clock_timestamp() - interval '8 minutes' + g * interval '1 millisecond'
    FROM generate_series(1,61) g RETURNING id
  `, [ownerA.tenant.id, field, ownerA.user.id])).rows.map(row => row.id);
  assert.equal(fixtures.length, 61);

  const region = await openInbox(page);
  await pageCount(region, 50, 1);
  const firstButtons = await region.getByRole('button',
    { name: 'Abrir orden y comprobar' }).allTextContents();
  assert.equal(firstButtons.length, 50);
  const next = region.getByRole('button', { name: 'Página siguiente de pendientes' });
  const previous = region.getByRole('button', { name: 'Página anterior de pendientes' });
  assert.equal(await previous.isDisabled(), true);
  assert.equal(await next.isDisabled(), false);
  const originalA = await region.innerText();
  assert.ok(originalA.includes('Real review browser'));
  assert.ok(!originalA.includes('Demostración:'));
  console.log('PASS: Chromium rendered fifty authorized orders from real PostGIS/Express');

  // Delay a genuine HTTP 200 to prove the prior page disappears while
  // loading. Route.fetch talks to Express; no synthetic successful payload.
  let started;
  let release;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const delayed = new Promise(resolve => { release = resolve; });
  let delayedOnce = false;
  const delayedHandler = async route => {
    if (delayedOnce) return route.continue();
    delayedOnce = true;
    const response = await route.fetch();
    assert.equal(response.status(), 200, 'Delayed page must be a real backend response');
    started();
    await delayed;
    try { await route.fulfill({ response }); }
    catch { /* A cancelled request may close before fulfillment. */ }
  };
  await page.route('**/api/v1/work-orders/review-queue?cursor=*', delayedHandler);
  await next.focus();
  await page.keyboard.press('Enter');
  await startedPromise;
  await region.getByText('Consultando pendientes autorizados…').waitFor();
  assert.equal(await region.getByRole('button', { name: 'Abrir orden y comprobar' }).count(), 0,
    'Old page must not be painted as current while next page is pending');
  release();
  await pageCount(region, 11, 2);
  await headingFocused(page, region);
  await page.unroute('**/api/v1/work-orders/review-queue?cursor=*', delayedHandler);
  assert.equal(await next.isDisabled(), true);
  console.log('PASS: keyboard next + real delayed HTTP, no stale flash, 11 real rows and heading focus');

  await previous.focus();
  await page.keyboard.press('Enter');
  await pageCount(region, 50, 1);
  await headingFocused(page, region);
  console.log('PASS: keyboard previous restores first page and accessible focus');

  // Alter the actual signed cursor in the outgoing request: PostgreSQL /
  // Express must reject it with a real 422, not mocked browser JSON.
  let cursorRejection;
  await page.route('**/api/v1/work-orders/review-queue?cursor=*', async route => {
    const url = new URL(route.request().url());
    const original = url.searchParams.get('cursor');
    assert.ok(original && original.length > 40);
    url.searchParams.set('cursor', original + 'x');
    await route.continue({ url: url.toString() });
  }, { times: 1 });
  cursorRejection = page.waitForResponse(res =>
    res.url().includes('/work-orders/review-queue?cursor=') && res.status() === 422);
  await next.click();
  const rejected = await cursorRejection;
  const rejectedBody = await rejected.json();
  assert.equal(rejectedBody.error.code, 'ORDER_REVIEW_CURSOR_INVALID');
  const restart = region.getByRole('button', { name: 'Iniciar nueva consulta' });
  await restart.waitFor();
  await page.waitForFunction(() => document.activeElement?.textContent?.trim() ===
    'Iniciar nueva consulta');
  assert.equal(await region.getByRole('button', {
    name: 'Abrir orden y comprobar' }).count(), 0);
  await restart.click();
  await pageCount(region, 50, 1);
  assert.equal(await previous.isDisabled(), true);
  console.log('PASS: real backend signed-cursor 422 triggers focused restart, never an empty success');

  // Abort the following page's transport. Only an explicit same-page retry
  // is valid, and it must eventually fetch the genuine second page.
  await page.route('**/api/v1/work-orders/review-queue?cursor=*',
    route => route.abort('failed'), { times: 1 });
  await next.focus();
  await page.keyboard.press('Enter');
  const retry = region.getByRole('button', { name: 'Reintentar' });
  await retry.waitFor();
  await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Reintentar');
  assert.equal(await region.getByRole('button', { name: 'Abrir orden y comprobar' }).count(), 0);
  await retry.click();
  await pageCount(region, 11, 2);
  console.log('PASS: interrupted HTTP never produces fake data; explicit retry recovers');

  // Same-cookie logout removes the entire tenant-scoped inbox. Logging in as
  // a different, real registered tenant must not revive old entries/cursors.
  await page.getByRole('navigation', { name: 'Principal' })
    .getByRole('button', { name: 'Cerrar sesión' }).click();
  await page.getByRole('heading', { name: 'Iniciar sesión' }).waitFor();
  assert.equal(await region.count(), 0);
  assert.equal((await context.cookies()).some(item => item.name === 'sedeagro_session'), false);
  const ownerB = await register(page, 'Queue Browser B');
  assert.notEqual(ownerB.tenant.id, ownerA.tenant.id);
  const regionB = await openInbox(page);
  await pageCount(regionB, 0, 1);
  assert.equal((await regionB.innerText()).includes('Real review browser'), false);
  assert.equal(await regionB.getByRole('button', { name: 'Página siguiente de pendientes' })
    .isDisabled(), true);
  console.log('PASS: true cross-tenant login hides previous review records and cursor navigation');
} finally {
  if (browser) await browser.close();
  if (vite) vite.kill();
  if (backend) backend.kill();
  for (const item of created.reverse()) {
    await admin.query('DELETE FROM tenants WHERE id=$1', [item.tenantId]).catch(() => {});
    await admin.query('DELETE FROM users WHERE id=$1', [item.userId]).catch(() => {});
  }
  await admin.end().catch(() => {});
}
