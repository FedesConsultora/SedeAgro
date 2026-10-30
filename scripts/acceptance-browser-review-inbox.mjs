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
import { runHttpReviewLoad } from './benchmark-review-queue-http.mjs';

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

  // State filters now query the ENTIRE authorized tenant before LIMIT.
  const filters = region.getByRole('group', { name: 'Estado de revisión (todas las páginas)' });
  await filters.getByRole('button', { name: 'Revisión humana' }).click();
  await pageCount(region, 0, 1);
  assert.equal(await next.isDisabled(), true, 'No global matches means no cursor');
  assert.equal(await filters.getByRole('button', { name: 'Revisión humana' })
    .getAttribute('aria-pressed'), 'true');
  await filters.getByRole('button', { name: 'Sin parte' }).click();
  await pageCount(region, 50, 1);
  assert.equal(await next.isDisabled(), false);
  await filters.getByRole('button', { name: 'Todas' }).click();
  await pageCount(region, 50, 1);
  console.log('PASS: global state filters query actual Express and produce bounded cursors');

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
  assert.equal(await filters.getByRole('button', { name: 'Todas' }).getAttribute('aria-pressed'),
    'true', 'Changing server page resets previous page-local filter');
  await region.getByText(/11 órdenes coincidentes en esta página/).waitFor();
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

  await filters.getByRole('button', { name: 'Posible cierre' }).click();
  await pageCount(region, 0, 1);
  await region.getByRole('button', { name: 'Actualizar pendientes' }).click();
  await pageCount(region, 0, 1);
  assert.equal(await filters.getByRole('button', { name: 'Posible cierre' })
    .getAttribute('aria-pressed'), 'true', 'Refresh must retain the global filter');
  await filters.getByRole('button', { name: 'Todas' }).click();
  await pageCount(region, 50, 1);
  assert.equal(await previous.isDisabled(), true);
  console.log('PASS: refresh retains global review state; selecting all resets to first page');

  // Filter SQL BEFORE LIMIT: fifty-five fresh applications appear ahead of
  // sixty-one older inspections in the unfiltered ordering.
  const apps = await admin.query(`
    INSERT INTO work_orders (tenant_id,field_id,requested_by,type,status,title,created_at)
    SELECT $1,$2,$3,'application','in_progress',
      'Global application ' || LPAD(g::text, 3, '0'),
      clock_timestamp() - interval '2 minutes' + g * interval '1 millisecond'
    FROM generate_series(1,55) g RETURNING id
  `, [ownerA.tenant.id, field, ownerA.user.id]);
  assert.equal(apps.rowCount, 55);
  const workType = region.getByLabel('Tipo de labor (todas las páginas)');
  await workType.selectOption('inspection');
  await pageCount(region, 50, 1);
  assert.ok((await region.innerText()).includes('Real review browser'));
  assert.ok(!(await region.innerText()).includes('Global application'));
  await workType.selectOption('application');
  await pageCount(region, 50, 1);
  assert.ok((await region.innerText()).includes('Global application'));
  assert.ok(!(await region.innerText()).includes('Real review browser'));

  // The cursor must be rejected when replayed with another SQL predicate.
  await page.route('**/api/v1/work-orders/review-queue?cursor=*&type=application', async route => {
    const url = new URL(route.request().url());
    url.searchParams.set('type', 'inspection');
    await route.continue({ url: url.toString() });
  }, { times: 1 });
  const filterReplay = page.waitForResponse(res =>
    res.url().includes('/work-orders/review-queue?cursor=') && res.status() === 422);
  await next.click();
  assert.equal((await (await filterReplay).json()).error.code, 'ORDER_REVIEW_CURSOR_INVALID');
  await region.getByRole('button', { name: 'Iniciar nueva consulta' }).click();
  await pageCount(region, 50, 1);
  assert.equal(await workType.inputValue(), 'application');
  await next.click();
  await pageCount(region, 5, 2);
  await headingFocused(page, region);
  assert.equal(await next.isDisabled(), true);
  console.log('PASS: SQL-wide type filter 55 application 50/5, cursor type replay 422');

  await workType.selectOption('inspection');
  await pageCount(region, 50, 1);
  assert.equal(await previous.isDisabled(), true);
  await next.click();
  await pageCount(region, 11, 2);
  await workType.selectOption('all');
  await pageCount(region, 50, 1);
  assert.equal(await previous.isDisabled(), true);
  console.log('PASS: SQL-wide inspection returns older rows and type switch resets cursor');

  // Introduce submitted reports only for all 55 NEWEST application orders.
  // Global no_report must skip these and return OLD inspection rows beyond
  // the first unfiltered 50, instead of incorrectly filtering one page.
  const reportRows = await admin.query(`
    INSERT INTO work_order_executions
      (tenant_id,work_order_id,submitted_by,started_at,finished_at,
       worked_area_hectares,result_summary,review_status,created_at)
    SELECT $1,wo.id,$2,now() - interval '2 hours',now() - interval '1 hour',
      1.50,'Verified fixture provenance for review filter test','submitted',now()
    FROM work_orders wo WHERE wo.tenant_id=$1 AND wo.type='application'
      AND wo.status='in_progress' AND wo.title LIKE 'Global application %'
    RETURNING id
  `, [ownerA.tenant.id, ownerA.user.id]);
  assert.equal(reportRows.rowCount, 55);
  await filters.getByRole('button', { name: 'Sin parte' }).click();
  await pageCount(region, 50, 1);
  assert.ok((await region.innerText()).includes('Real review browser'));
  assert.ok(!(await region.innerText()).includes('Global application'));
  await next.click();
  await pageCount(region, 11, 2);
  await filters.getByRole('button', { name: 'Con bloqueos' }).click();
  await pageCount(region, 50, 1);
  assert.ok((await region.innerText()).includes('Global application'));
  await next.click();
  await pageCount(region, 5, 2);
  console.log('PASS: global no-report 50/11 and blocked 50/5 match source DB reports before LIMIT');
  await filters.getByRole('button', { name: 'Todas' }).click();
  await pageCount(region, 50, 1);

  // Reclassify ONLY the newer application fixtures as urgent, leaving the
  // 61 older inspections normal. Global priority must filter BEFORE LIMIT 51.
  const urgentSeed = await admin.query(`
    UPDATE work_orders SET priority='urgent'
    WHERE tenant_id=$1 AND type='application' AND title LIKE 'Global application %'
    RETURNING id
  `, [ownerA.tenant.id]);
  assert.equal(urgentSeed.rowCount, 55);
  const priorityFilter = region.getByLabel('Prioridad (todas las páginas)');
  await priorityFilter.selectOption('normal');
  await pageCount(region, 50, 1);
  assert.ok((await region.innerText()).includes('Real review browser'));
  assert.ok(!(await region.innerText()).includes('Global application'));
  await next.click();
  await pageCount(region, 11, 2);
  await headingFocused(page, region);
  await priorityFilter.selectOption('urgent');
  await pageCount(region, 50, 1);
  assert.equal(await previous.isDisabled(), true);
  assert.ok((await region.innerText()).includes('Global application'));
  assert.ok(!(await region.innerText()).includes('Real review browser'));

  // Alter only the work priority in an actual signed paginated request.
  // The backend must reject the cross-priority replay, not use a fake 422.
  await page.route('**/api/v1/work-orders/review-queue?cursor=*&priority=urgent', async route => {
    const url = new URL(route.request().url());
    assert.equal(url.searchParams.get('priority'), 'urgent');
    url.searchParams.set('priority', 'normal');
    await route.continue({ url: url.toString() });
  }, { times: 1 });
  const crossPriority = page.waitForResponse(res =>
    res.url().includes('/work-orders/review-queue?cursor=') &&
    res.status() === 422);
  await next.click();
  assert.equal((await (await crossPriority).json()).error.code,
    'ORDER_REVIEW_CURSOR_INVALID');
  await region.getByRole('button', { name: 'Iniciar nueva consulta' }).click();
  await pageCount(region, 50, 1);
  assert.equal(await priorityFilter.inputValue(), 'urgent');
  await next.click();
  await pageCount(region, 5, 2);
  await headingFocused(page, region);
  assert.equal(await next.isDisabled(), true);

  // Global filters compose; priority switches preserve type/state while
  // resetting the signed cursor. Page count never claims tenant-wide totals.
  await filters.getByRole('button', { name: 'Con bloqueos' }).click();
  await pageCount(region, 50, 1);
  assert.equal(await priorityFilter.inputValue(), 'urgent');
  await workType.selectOption('application');
  await pageCount(region, 50, 1);
  assert.equal(await filters.getByRole('button', { name: 'Todas' })
    .getAttribute('aria-pressed'), 'true');
  await priorityFilter.selectOption('normal');
  await pageCount(region, 0, 1);
  assert.equal(await next.isDisabled(), true);
  await priorityFilter.selectOption('urgent');
  await pageCount(region, 50, 1);
  await workType.selectOption('all');
  await pageCount(region, 50, 1);
  await priorityFilter.selectOption('all');
  await pageCount(region, 50, 1);
  console.log('PASS: global priority SQL normal 50/11, urgent 50/5, all filters compose, real cursor replay 422');

  // Fixture deadline partition: older inspections are overdue, newer
  // applications fall into the next 168h; no synthetic backend response.
  const overdueSeed = await admin.query(`
    UPDATE work_orders SET due_at=now() - interval '1 day'
    WHERE tenant_id=$1 AND title LIKE 'Real review browser %' RETURNING id
  `, [ownerA.tenant.id]);
  const upcomingSeed = await admin.query(`
    UPDATE work_orders SET due_at=now() + interval '1 day'
    WHERE tenant_id=$1 AND title LIKE 'Global application %' RETURNING id
  `, [ownerA.tenant.id]);
  assert.equal(overdueSeed.rowCount, 61);
  assert.equal(upcomingSeed.rowCount, 55);
  const dueFilter = region.getByLabel('Vencimiento (todas las páginas)');
  await dueFilter.selectOption('overdue');
  await pageCount(region, 50, 1);
  assert.ok((await region.innerText()).includes('Real review browser'));
  assert.ok(!(await region.innerText()).includes('Global application'));
  await next.click();
  await pageCount(region, 11, 2);
  await headingFocused(page, region);
  await dueFilter.selectOption('next_7_days');
  await pageCount(region, 50, 1);
  assert.ok((await region.innerText()).includes('Global application'));
  assert.ok(!(await region.innerText()).includes('Real review browser'));
  assert.equal(await previous.isDisabled(), true);

  // Replay a real signed cursor against a different time window: 422.
  await page.route('**/api/v1/work-orders/review-queue?cursor=*&due=next_7_days', async route => {
    const url = new URL(route.request().url());
    assert.equal(url.searchParams.get('due'), 'next_7_days');
    url.searchParams.set('due', 'overdue');
    await route.continue({ url: url.toString() });
  }, { times: 1 });
  const crossDeadline = page.waitForResponse(res =>
    res.url().includes('/work-orders/review-queue?cursor=') &&
    res.status() === 422);
  await next.click();
  assert.equal((await (await crossDeadline).json()).error.code,
    'ORDER_REVIEW_CURSOR_INVALID');
  await region.getByRole('button', { name: 'Iniciar nueva consulta' }).click();
  await pageCount(region, 50, 1);
  assert.equal(await dueFilter.inputValue(), 'next_7_days');
  await next.click();
  await pageCount(region, 5, 2);
  await headingFocused(page, region);
  assert.equal(await next.isDisabled(), true);

  await dueFilter.selectOption('unscheduled');
  await pageCount(region, 0, 1);
  await dueFilter.selectOption('later');
  await pageCount(region, 0, 1);
  await dueFilter.selectOption('overdue');
  await pageCount(region, 50, 1);
  // Composed filters remain evaluated in PostgreSQL before pagination.
  await workType.selectOption('inspection');
  await pageCount(region, 50, 1);
  await filters.getByRole('button', { name: 'Sin parte' }).click();
  await pageCount(region, 50, 1);
  await priorityFilter.selectOption('normal');
  await pageCount(region, 50, 1);
  assert.equal(await dueFilter.inputValue(), 'overdue');
  assert.equal(await next.isDisabled(), false);
  await workType.selectOption('all');
  await pageCount(region, 50, 1);
  await priorityFilter.selectOption('all');
  await pageCount(region, 50, 1);
  await filters.getByRole('button', { name: 'Todas' }).click();
  await pageCount(region, 50, 1);
  await dueFilter.selectOption('all');
  await pageCount(region, 50, 1);
  console.log('PASS: SQL-global deadlines overdue 50/11, next 168h 50/5, none missing/later, real HMAC 422');


  // Search text is matched against ALL tenant-authorized titles BEFORE LIMIT 51.
  // The 55 NEWER applications precede all 61 older "Real review browser" titles.
  const titleSearch = region.getByRole('search');
  const titleBox = titleSearch.getByRole('searchbox', {
    name: 'Buscar por título (todas las páginas)'
  });
  const submitTitle = titleSearch.getByRole('button', { name: 'Buscar órdenes' });
  const clearTitle = titleSearch.getByRole('button', { name: 'Limpiar búsqueda' });
  await titleBox.fill('  rEaL  review   Browser  ');
  await submitTitle.click();
  await pageCount(region, 50, 1);
  assert.ok((await region.innerText()).includes('Real review browser'));
  assert.ok(!(await region.innerText()).includes('Global application'));
  await next.click();
  await pageCount(region, 11, 2);
  await headingFocused(page, region);
  console.log('PASS: case-insensitive global title search sees 61 OLD matches beyond newer page');

  // Percent and underscore are literal characters, NEVER ILIKE wildcards.
  await titleBox.fill('%_');
  await submitTitle.click();
  await pageCount(region, 0, 1);
  assert.equal(await next.isDisabled(), true);
  await titleBox.fill('a');
  await submitTitle.click();
  await titleSearch.getByRole('alert').waitFor();
  await pageCount(region, 0, 1); // Validation must NOT replace active query.
  await clearTitle.click();
  await pageCount(region, 50, 1);
  assert.equal(await previous.isDisabled(), true);
  console.log('PASS: literal %_ is not wildcard; invalid short search never clears active results');

  // Search also composes with ALL existing SQL filters and resets cursors.
  await workType.selectOption('application');
  await pageCount(region, 50, 1);
  await priorityFilter.selectOption('urgent');
  await pageCount(region, 50, 1);
  await dueFilter.selectOption('next_7_days');
  await pageCount(region, 50, 1);
  await filters.getByRole('button', { name: 'Con bloqueos' }).click();
  await pageCount(region, 50, 1);
  await titleBox.fill('Global application');
  await submitTitle.click();
  await pageCount(region, 50, 1);
  assert.ok((await region.innerText()).includes('Global application'));

  // Change only q on a real signed request, preserving its other four filters.
  await page.route('**/api/v1/work-orders/review-queue?cursor=*', async route => {
    const url = new URL(route.request().url());
    assert.equal(url.searchParams.get('q'), 'Global application');
    url.searchParams.set('q', 'Real review browser');
    await route.continue({ url: url.toString() });
  }, { times: 1 });
  const replayedTitle = page.waitForResponse(res =>
    res.url().includes('/work-orders/review-queue?cursor=') && res.status() === 422);
  await next.click();
  assert.equal((await (await replayedTitle).json()).error.code, 'ORDER_REVIEW_CURSOR_INVALID');
  await region.getByRole('button', { name: 'Iniciar nueva consulta' }).click();
  await pageCount(region, 50, 1);
  assert.equal(await titleBox.inputValue(), 'Global application');
  await next.click();
  await pageCount(region, 5, 2);
  await headingFocused(page, region);
  assert.equal(await next.isDisabled(), true);
  await clearTitle.click();
  await pageCount(region, 50, 1);
  assert.equal(await priorityFilter.inputValue(), 'urgent');
  assert.equal(await dueFilter.inputValue(), 'next_7_days');
  assert.equal(await filters.getByRole('button', { name: 'Con bloqueos' })
    .getAttribute('aria-pressed'), 'true');
  await workType.selectOption('all');
  await pageCount(region, 50, 1);
  await priorityFilter.selectOption('all');
  await pageCount(region, 50, 1);
  await dueFilter.selectOption('all');
  await pageCount(region, 50, 1);
  console.log('PASS: composable title search 50/5, cross-query HMAC 422, clear retains global filters');


  // Sorting runs on the full SQL tenant query, never on the current page.
  // 55 newer application rows are urgent; 61 older inspections are normal.
  const sortSelector = region.getByLabel('Ordenar resultados (todas las páginas)');
  const rowTitles = () => region.locator('.orders-workspace__review-item strong').allTextContents();
  await sortSelector.selectOption('priority_first');
  await pageCount(region,50,1);
  assert.equal((await rowTitles()).every(title=>title.startsWith('Global application')),true);

  // Replay the exact HMAC token under a DIFFERENT sort mode against Express.
  await page.route('**/api/v1/work-orders/review-queue?cursor=*',async route=>{
    const url=new URL(route.request().url());
    assert.equal(url.searchParams.get('sort'),'priority_first');
    url.searchParams.set('sort','due_first');
    await route.continue({url:url.toString()});
  },{times:1});
  const badSort=page.waitForResponse(response=>
    response.url().includes('/work-orders/review-queue?cursor=') &&
    response.status()===422);
  await next.click();
  assert.equal((await (await badSort).json()).error.code,'ORDER_REVIEW_CURSOR_INVALID');
  await region.getByRole('button',{name:'Iniciar nueva consulta'}).click();
  await pageCount(region,50,1);
  assert.equal(await sortSelector.inputValue(),'priority_first');
  await next.click();
  await pageCount(region,50,2);
  assert.equal((await rowTitles()).filter(title=>title.startsWith('Global application')).length,5);
  assert.equal((await rowTitles()).filter(title=>title.startsWith('Real review browser')).length,45);
  await next.click();
  await pageCount(region,16,3);
  assert.equal((await rowTitles()).every(title=>title.startsWith('Real review browser')),true);
  assert.equal(await next.isDisabled(),true);
  console.log('PASS: priority-first global 50/50/16 with SQL tie keys, real signed sort replay 422');

  // Due sorting puts NULLs at the very END rather than treating them as
  // overdue or today. One older inspection becomes undated deliberately.
  const undatedSort = await admin.query(`
    UPDATE work_orders SET due_at=NULL
    WHERE id=(SELECT id FROM work_orders
      WHERE tenant_id=$1 AND title LIKE 'Real review browser %'
      ORDER BY id ASC LIMIT 1)
    RETURNING id,title
  `,[ownerA.tenant.id]);
  assert.equal(undatedSort.rowCount,1);
  await sortSelector.selectOption('due_first');
  await pageCount(region,50,1);
  assert.equal(await previous.isDisabled(),true);
  assert.equal((await rowTitles()).every(title=>title.startsWith('Real review browser')),true);
  await next.click();
  await pageCount(region,50,2);
  assert.equal((await rowTitles()).filter(title=>title.startsWith('Real review browser')).length,10);
  assert.equal((await rowTitles()).filter(title=>title.startsWith('Global application')).length,40);
  await next.click();
  await pageCount(region,16,3);
  const dueLast=await rowTitles();
  assert.equal(dueLast.filter(title=>title.startsWith('Global application')).length,15);
  assert.equal(dueLast.at(-1),undatedSort.rows[0].title,'NULL due must be last');
  assert.equal(await next.isDisabled(),true);
  console.log('PASS: due-first global keyset 50/50/16, equal dates tie by creation, null last');

  // Sorting composes with an existing title search and is reset without
  // retaining the outgoing signed cursor.
  await titleBox.fill('Real review browser');
  await submitTitle.click();
  await pageCount(region,50,1);
  assert.equal(await sortSelector.inputValue(),'due_first');
  await next.click();
  await pageCount(region,11,2);
  assert.equal((await rowTitles()).at(-1),undatedSort.rows[0].title);
  await sortSelector.selectOption('newest');
  await pageCount(region,50,1);
  assert.equal(await previous.isDisabled(),true);
  await clearTitle.click();
  await pageCount(region,50,1);
  assert.equal(await sortSelector.inputValue(),'newest');
  assert.equal((await rowTitles()).every(title=>title.startsWith('Global application')),true);
  console.log('PASS: sort + title compose; changing sort resets cursors; newest remains backward compatible');


  // Persist an authorized saved view via the real API, then reload the app
  // to prove it does not depend on volatile React state or browser storage.
  await workType.selectOption('inspection');
  await pageCount(region,50,1);
  await priorityFilter.selectOption('normal');
  await pageCount(region,50,1);
  await dueFilter.selectOption('overdue');
  await pageCount(region,50,1);
  await sortSelector.selectOption('due_first');
  await pageCount(region,50,1);
  await filters.getByRole('button',{name:'Sin parte'}).click();
  await pageCount(region,50,1);
  await titleBox.fill('Real review browser');
  await submitTitle.click();
  await pageCount(region,50,1);
  await region.getByLabel('Nombre de la nueva vista').fill('  Mis   inspecciones vencidas  ');
  await region.getByRole('button',{name:'Guardar filtros actuales'}).click();
  await region.getByText('Vista guardada. Podés recuperarla en tu próxima sesión.').waitFor();
  // Only the tenant admin can publish or unpublish a personally owned view.
  await region.getByRole('button',{name:'Compartir con coordinación'}).click();
  await region.getByText('Vista compartida con coordinación de esta empresa.').waitFor();
  assert.equal(await region.getByRole('button',{name:'Dejar de compartir'}).count(),1);

  const savedSelector=region.getByLabel('Elegir vista guardada');
  assert.equal(await savedSelector.locator('option').count(),2);
  const savedId=await savedSelector.inputValue();
  assert.ok(savedId,'Successful save automatically selects the new view');
  await page.reload();
  await openInbox(page);
  await region.getByText('1 de 10 vistas guardadas.').waitFor();
  await savedSelector.selectOption(savedId);
  await pageCount(region,50,1);
  assert.equal(await region.getByRole('button',{name:'Dejar de compartir'}).count(),1);

  // Deliberately change the current criteria, then restore the saved query.
  await workType.selectOption('all');
  await pageCount(region,50,1);
  await dueFilter.selectOption('all');
  await pageCount(region,50,1);
  await titleBox.fill('%_');
  await submitTitle.click();
  await pageCount(region,0,1);
  await region.getByRole('button',{name:'Aplicar vista'}).click();
  await pageCount(region,50,1);
  assert.equal(await workType.inputValue(),'inspection');
  assert.equal(await priorityFilter.inputValue(),'normal');
  assert.equal(await dueFilter.inputValue(),'overdue');
  assert.equal(await sortSelector.inputValue(),'due_first');
  assert.equal(await titleBox.inputValue(),'Real review browser');
  assert.equal(await filters.getByRole('button',{name:'Sin parte'})
    .getAttribute('aria-pressed'),'true');
  await next.click();
  // The due-sort fixture intentionally made one of the 61 inspections NULL,
  // so overdue finds 60 orders and the second page has 10, not 11.
  await pageCount(region,10,2);
  await region.getByRole('button',{name:'Dejar de compartir'}).click();
  await region.getByText('Vista nuevamente privada para tu usuario.').waitFor();
  assert.equal(await region.getByRole('button',{name:'Compartir con coordinación'}).count(),1);
    await region.getByRole('button',{name:'Eliminar vista…'}).click();
  await region.getByText('¿Eliminar esta vista guardada?').waitFor();
  await region.getByRole('button',{name:'Cancelar'}).click();
  assert.equal(await savedSelector.locator('option').count(),2);
  await region.getByRole('button',{name:'Eliminar vista…'}).click();
  await region.getByRole('button',{name:'Confirmar eliminación'}).click();
  await region.getByText('Vista eliminada. Los filtros actuales no cambiaron.').waitFor();
  assert.equal(await savedSelector.locator('option').count(),1);
  assert.equal(await region.getByLabel('Vencimiento (todas las páginas)').inputValue(),'overdue');
  console.log('PASS: member-owned saved view survives reload, restores six filters/cursor, delete requires confirmation');

  // Seed a DIFFERENT active admin in the same disposable tenant. Browser
  // remains logged in as ownerA and must never gain ownership over this view.
  const extraAuthor=(await admin.query(`
    INSERT INTO users(full_name,email,password_hash,status)
    VALUES($1,$2,'browser-test-only','active') RETURNING id
  `,['Review Moderation Publisher','review-mod-'+token+'@example.test'])).rows[0].id;
  created.push({tenantId:ownerA.tenant.id,userId:extraAuthor});
  await admin.query(`
    INSERT INTO memberships(tenant_id,user_id,role_code,status)
    VALUES($1,$2,'tenant_admin','active')
  `,[ownerA.tenant.id,extraAuthor]);
  const anotherAdminView=(await admin.query(`
    INSERT INTO work_order_review_views
      (tenant_id,user_id,name,filters,visibility)
    VALUES($1,$2,$3,$4::jsonb,'shared') RETURNING id
  `,[ownerA.tenant.id,extraAuthor,'Moderación navegador '+token,
    JSON.stringify({workType:'inspection',reviewState:'no_report',
      priority:'normal',dueWindow:'all',titleQuery:'',sortMode:'newest'})]))
    .rows[0].id;
  const moderatorPanel=region.getByRole('region',{name:'Moderación de vistas compartidas'});
  await moderatorPanel.getByRole('button',
    {name:'Actualizar publicaciones y auditoría'}).click();
  await moderatorPanel.getByText('1 publicaciones ajenas visibles para moderación.').waitFor();
  const moderatorTarget=moderatorPanel.getByLabel('Publicación a revisar');
  await moderatorTarget.selectOption(anotherAdminView);
  const moderatorReason=moderatorPanel.getByLabel('Motivo de revocación');
  await moderatorReason.fill('corta');
  await moderatorPanel.getByRole('button',{name:'Revisar revocación'}).click();
  await moderatorPanel.getByRole('alert').waitFor();
  assert.equal(await moderatorPanel.getByRole('button',
    {name:'Confirmar revocación'}).count(),0,
    'A short invalid reason must not arm a mutation');
  await moderatorReason.fill('  Publicación  obsoleta  en esta campaña  ');
  await moderatorPanel.getByRole('button',{name:'Revisar revocación'}).click();
  await moderatorPanel.getByRole('button',{name:'Cancelar revocación'}).click();
  assert.equal(await moderatorPanel.getByRole('button',
    {name:'Confirmar revocación'}).count(),0,'Cancel must disarm the revocation');
  await moderatorPanel.getByRole('button',{name:'Revisar revocación'}).click();
  await moderatorPanel.getByRole('button',{name:'Confirmar revocación'}).click();
  await moderatorPanel.getByText(
    'Publicación revocada y auditoría registrada. La vista sigue siendo privada de su autor.'
  ).waitFor();
  await moderatorPanel.getByText('0 publicaciones ajenas visibles para moderación.').waitFor();
  const afterModeration=(await admin.query(`
    SELECT visibility, user_id, filters FROM work_order_review_views
    WHERE tenant_id=$1 AND id=$2
  `,[ownerA.tenant.id,anotherAdminView])).rows;
  assert.equal(afterModeration.length,1);
  assert.equal(afterModeration[0].visibility,'private');
  assert.equal(afterModeration[0].user_id,extraAuthor);
  assert.equal(afterModeration[0].filters.workType,'inspection');
  const durableAudit=(await admin.query(`
    SELECT reason,action,actor_user_id,view_owner_id
    FROM work_order_review_view_moderation_audit
    WHERE tenant_id=$1 AND view_id=$2
  `,[ownerA.tenant.id,anotherAdminView])).rows;
  assert.equal(durableAudit.length,1,'Exactly one audit event must be committed');
  assert.equal(durableAudit[0].reason,'Publicación obsoleta en esta campaña');
  assert.equal(durableAudit[0].actor_user_id,ownerA.user.id);
  assert.equal(durableAudit[0].view_owner_id,extraAuthor);
  await page.reload();
  await openInbox(page);
  await moderatorPanel.getByText('0 publicaciones ajenas visibles para moderación.').waitFor();
  // Audit is intentionally collapsed by default; open the disclosure before
  // asserting its persisted contents after a real application reload.
  await moderatorPanel.getByText('Historial de revocaciones (últimas 50)').click();
  await moderatorPanel.getByText('Publicación obsoleta en esta campaña').waitFor();
  console.log('PASS: real Chromium admin revokes another publisher only after confirmation; audit survives reload and view stays private with owner');

  // A genuine execution POST may commit but lose its reply on unstable radio.
  // Reconcile through the live authorized order detail, not another POST.
  const interruptedTitle = 'Browser execution ACK lost ' + token;
  const interruptedOrder = (await admin.query(`
    INSERT INTO work_orders
      (tenant_id,field_id,requested_by,type,status,title,approved_at)
    VALUES ($1,$2,$3,'inspection','in_progress',$4,now()-interval '2 hours')
    RETURNING id
  `, [ownerA.tenant.id,field,ownerA.user.id,interruptedTitle])).rows[0].id;
  await page.reload();
  await page.getByTitle('Órdenes').click();
  await page.getByRole('heading',{name:'Órdenes de trabajo'}).waitFor();
  await page.getByPlaceholder('Buscar orden o lote').fill(interruptedTitle);
  await page.getByRole('button',{name:'Abrir orden: '+interruptedTitle}).click();
  const executionDrawer = page.getByRole('dialog',{name:interruptedTitle});
  const executionForm = executionDrawer.locator('.order-detail__execution-form');
  await executionForm.waitFor();
  const localTimes = await page.evaluate(() => {
    const local = minutesAgo => {
      const d = new Date(Date.now() - minutesAgo * 60 * 1000);
      const pad = n => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
        'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    };
    return { started: local(45), finished: local(15) };
  });
  await executionForm.locator('input[type="datetime-local"]').nth(0).fill(localTimes.started);
  await executionForm.locator('input[type="datetime-local"]').nth(1).fill(localTimes.finished);
  await executionForm.locator('input[type="number"]').fill('12.50');
  await executionForm.getByPlaceholder('Describí qué se hizo, resultado y cualquier desvío observado.')
    .fill('Inspección de campo completada durante la visita programada.');
  await executionForm.locator('input[type="checkbox"]').check();

  let executionPostCount = 0;
  let persistedExecutionId;
  await page.route('**/api/v1/work-orders/' + interruptedOrder + '/executions', async route => {
    executionPostCount += 1;
    const actual = await route.fetch();
    assert.equal(actual.status(),201,await actual.text());
    const receipt = await actual.json();
    assert.equal(receipt.data.work_order_id,interruptedOrder);
    assert.equal(receipt.data.submitted_by,ownerA.user.id);
    persistedExecutionId = receipt.data.id;
    // Only the browser-facing ACK is dropped AFTER the real DB commit.
    await route.abort('failed');
  });
  await executionForm.getByRole('button',{name:'Presentar parte para revisión'}).click();
  // The UI must use a new genuine authorized GET and eventually render the
  // confirmed report without a second write, even when the ACK is absent.
  await executionDrawer.getByText('Declarado — pendiente de revisión').waitFor();
  assert.equal(executionPostCount,1,'Lost ACK must never trigger an automatic retry');
  const recoveredExecution = (await admin.query(`
    SELECT id,submitted_by,review_status FROM work_order_executions
    WHERE tenant_id=$1 AND work_order_id=$2
  `,[ownerA.tenant.id,interruptedOrder])).rows;
  assert.equal(recoveredExecution.length,1);
  assert.equal(recoveredExecution[0].id,persistedExecutionId);
  assert.equal(recoveredExecution[0].submitted_by,ownerA.user.id);
  assert.equal(recoveredExecution[0].review_status,'submitted');
  const executionAudits = (await admin.query(`
    SELECT count(*)::integer AS count FROM audit_events
    WHERE tenant_id=$1 AND entity_id=$2 AND action='work_order.execution_submitted'
  `,[ownerA.tenant.id,interruptedOrder])).rows[0].count;
  assert.equal(executionAudits,1,'Exactly one audit event after lost execution response');
  await page.unroute('**/api/v1/work-orders/' + interruptedOrder + '/executions');
  // Close the actual detail drawer before the existing final multi-tenant
  // logout test: its modal overlay deliberately captures background clicks.
  await executionDrawer.getByRole('button',{name:'Cerrar '+interruptedTitle}).click();
  assert.equal(await executionDrawer.count(),0,'Execution drawer must release the sidebar');
  console.log('PASS: real execution POST 201 COMMIT + lost ACK -> authorized GET reconciles, exactly one report and audit without repeat POST');

  // Real two-person acceptance: an authenticated reviewer clicks, the server
  // COMMITS the decision and audit, but only the browser HTTP ACK is lost.
  // A temporarily unavailable authorized GET leaves the user uncertain; an
  // explicit SAME-UUID retry must return 200 replayed without a second event.
  const reviewTitle = 'Browser review ACK lost ' + token;
  const reviewOrder = (await admin.query(`
    INSERT INTO work_orders
      (tenant_id,field_id,requested_by,type,status,title,approved_at)
    VALUES ($1,$2,$3,'inspection','in_progress',$4,now()-interval '2 hours')
    RETURNING id
  `,[ownerA.tenant.id,field,ownerA.user.id,reviewTitle])).rows[0].id;
  const reviewReport = (await admin.query(`
    INSERT INTO work_order_executions
      (tenant_id,work_order_id,submitted_by,started_at,finished_at,
       worked_area_hectares,result_summary)
    VALUES($1,$2,$3,now()-interval '1 hour',now()-interval '30 minutes',
      1.25,'Inspección reportada por un segundo administrador.')
    RETURNING id
  `,[ownerA.tenant.id,reviewOrder,extraAuthor])).rows[0].id;
  await page.reload();
  await page.getByTitle('Órdenes').click();
  await page.getByRole('heading',{name:'Órdenes de trabajo'}).waitFor();
  await page.getByPlaceholder('Buscar orden o lote').fill(reviewTitle);
  await page.getByRole('button',{name:'Abrir orden: '+reviewTitle}).click();
  const reviewDrawer = page.getByRole('dialog',{name:reviewTitle});
  const checkSection = reviewDrawer.getByRole('group',{name:/Controles de revisión/});
  await checkSection.waitFor();
  const checkboxes = checkSection.locator('input[type="checkbox"]');
  assert.equal(await checkboxes.count(),4);
  for (let i=0; i<4; i++) await checkboxes.nth(i).check();
  await checkSection.getByRole('combobox').selectOption('no_files');
  let reviewPostCount = 0;
  let originalReviewBody;
  const reviewEndpoint = '**/api/v1/work-orders/' + reviewOrder + '/executions/' + reviewReport + '/review';
  const detailEndpoint = '**/api/v1/work-orders/' + reviewOrder;
  await page.route(reviewEndpoint,async route=>{
    reviewPostCount++;
    originalReviewBody = route.request().postDataJSON();
    assert.match(originalReviewBody.client_request_id,/^[0-9a-f-]{36}$/);
    assert.equal(originalReviewBody.decision,'verified');
    const actual = await route.fetch();
    assert.equal(actual.status(),200,await actual.text());
    assert.equal((await actual.json()).replayed,false);
    await route.abort('failed'); // Drop only the browser ACK after real COMMIT.
  },{times:1});
  // Force only the next authorized GET to fail, never fake a successful reply.
  await page.route(detailEndpoint,route=>route.fulfill({
    status:503,contentType:'application/json',
    body:JSON.stringify({error:{message:'Sesión de verificación temporalmente no disponible'}})
  }),{times:1});
  page.once('dialog',dialog=>void dialog.accept());
  await reviewDrawer.getByRole('button',{name:'Aceptar revisión'}).click();
  const retryReview=reviewDrawer.getByRole('button',{name:'Reintentar revisión con la misma clave'});
  await retryReview.waitFor();
  assert.equal(reviewPostCount,1,'There must be no automatic second review POST');
  const retryReply=page.waitForResponse(response=>
    response.url().endsWith('/work-orders/'+reviewOrder+'/executions/'+reviewReport+'/review') &&
    response.request().method()==='POST' && response.status()===200);
  await retryReview.click();
  const replayResponse=await retryReply;
  const replayBody=await replayResponse.json();
  assert.equal(replayBody.replayed,true,'The real backend must acknowledge the first persisted review');
  assert.equal(replayBody.data.id,reviewReport);
  await reviewDrawer.getByText('Revisado por coordinación').waitFor();
  const reviewRows=(await admin.query(`
    SELECT review_status,reviewed_by,review_checklist
    FROM work_order_executions WHERE tenant_id=$1 AND id=$2
  `,[ownerA.tenant.id,reviewReport])).rows;
  assert.equal(reviewRows.length,1);
  assert.equal(reviewRows[0].review_status,'verified');
  assert.equal(reviewRows[0].reviewed_by,ownerA.user.id);
  assert.equal(reviewRows[0].review_checklist.evidence_basis,'no_files');
  const reviewAudits=(await admin.query(`
    SELECT count(*)::int AS count FROM audit_events
    WHERE tenant_id=$1 AND entity_id=$2 AND action='work_order.execution_reviewed'
  `,[ownerA.tenant.id,reviewOrder])).rows[0].count;
  const reviewReceipts=(await admin.query(`
    SELECT count(*)::int AS count FROM work_order_execution_review_requests
    WHERE tenant_id=$1 AND work_order_id=$2 AND reviewed_by=$3 AND client_request_id=$4
  `,[ownerA.tenant.id,reviewOrder,ownerA.user.id,
    originalReviewBody.client_request_id])).rows[0].count;
  assert.equal(reviewAudits,1,'Lost ACK + manual replay must create only one audit');
  assert.equal(reviewReceipts,1,'Durable UUID receipt must be recorded once');
  assert.equal(reviewPostCount,1,'Only first POST is intercepted; browser explicitly retried once');
  await reviewDrawer.getByRole('button',{name:'Cerrar '+reviewTitle}).click();
  await page.unroute(detailEndpoint);
  await page.unroute(reviewEndpoint);
  console.log('PASS: authentic two-person review POST COMMIT + lost ACK + temporary GET 503 + explicit same-UUID 200 replay, one audit and receipt');

  // Final independent API benchmark after all UI scenarios, so adding 5000
  // synthetic orders cannot change the earlier deterministic 50/61 assertions.
  // The browser's REAL HttpOnly cookie is forwarded by Playwright APIContext.
  await runHttpReviewLoad({
    admin, page, tenant: ownerA.tenant.id, field,
    reviewer: ownerA.user.id, submitter: extraAuthor
  });

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
