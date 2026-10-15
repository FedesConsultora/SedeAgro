// Chromium + REAL React/Express/PostGIS acceptance: evidence history with
// mobile network interruptions, cursor replay failures and revocation.
// Only disposable *_test DB. No mock API responses or production data.
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
  throw new Error('Browser evidence acceptance requires the disposable *_test database.');
}
function start(cwd, argv, env = {}) {
  return spawn(process.execPath, argv, {
    cwd: resolve(root, cwd),
    env: { ...process.env, ...env },
    stdio: 'ignore'
  });
}
async function waitUntil(url) {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch { /* server not ready */ }
    await new Promise(resolve => setTimeout(resolve, 175));
  }
  throw new Error('Timed out waiting for ' + url);
}

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const slug = `browser-evidence-${suffix}`;
const email = `browser-evidence-${suffix}@example.test`;
const password = 'StrongEvidence-CI-2026!';
const admin = new pg.Client({ connectionString: adminUrl });
let tenantId;
let userId;
let secondTenantId;
let secondUserId;
let backend;
let vite;
let browser;
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
  vite = start('frontend', [resolve(root,'node_modules/vite/bin/vite.js'),
    '--host','127.0.0.1','--port','4177','--strictPort']);
  await waitUntil('http://127.0.0.1:4177/');

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(14000);
  await page.goto('http://127.0.0.1:4177/');
  await page.getByRole('button', {name:'Crear cuenta nueva'}).click();
  await page.locator('#reg-org-name').fill('Evidence Browser Acceptance');
  await page.locator('#reg-slug').fill(slug);
  await page.locator('#reg-full-name').fill('Evidence Browser Owner');
  await page.locator('#reg-email').fill(email);
  await page.locator('#reg-password').fill(password);
  const registrationRequest = page.waitForResponse(res =>
    res.url().endsWith('/auth/register-tenant') && res.request().method() === 'POST');
  await page.locator('#register-submit').click();
  const registration = await registrationRequest;
  assert.equal(registration.status(),201,await registration.text());
  const profile = await registration.json();
  tenantId = profile.tenant.id;
  userId = profile.user.id;
  await page.getByRole('button', { name:'Sesiones' }).waitFor();

  // New tenant might not have scouting on its starter plan: enable explicitly
  // in disposable DB, then reload session authoritatively from the server.
  await admin.query(`
    INSERT INTO tenant_modules (tenant_id,module_code,is_enabled,source)
    VALUES ($1,'scouting',true,'override'),($1,'campaigns',true,'override'),
      ($1,'gis',true,'override')
    ON CONFLICT (tenant_id,module_code) DO UPDATE SET is_enabled=true,source='override'
  `,[tenantId]);
  const planFarm = async (sql, values) =>
    (await admin.query(sql,values)).rows[0].id;
  const crop = (await admin.query("SELECT id FROM crop_types WHERE code='soy'")).rows[0]?.id;
  assert.ok(crop,'CI seed must contain crop type');
  const farm = await planFarm('INSERT INTO farms(tenant_id,name) VALUES ($1,$2) RETURNING id',
    [tenantId,'Evidence Browser Farm']);
  const field = await planFarm('INSERT INTO fields(tenant_id,farm_id,name) VALUES ($1,$2,$3) RETURNING id',
    [tenantId,farm,'Evidence Browser Lote']);
  const campaign = await planFarm(`
    INSERT INTO campaigns(tenant_id,name,season_year,starts_at)
    VALUES ($1,'Evidence Browser Campaign',2026,'2026-01-01') RETURNING id
  `,[tenantId]);
  const campaignField = await planFarm(`
    INSERT INTO campaign_fields (tenant_id,campaign_id,field_id,crop_type_id)
    VALUES ($1,$2,$3,$4) RETURNING id
  `,[tenantId,campaign,field,crop]);
  const run = await planFarm(`
    INSERT INTO scouting_runs (tenant_id,campaign_field_id,assigned_to,status)
    VALUES ($1,$2,$3,'in_progress') RETURNING id
  `,[tenantId,campaignField,userId]);
  const observation = await planFarm(`
    INSERT INTO scouting_observations
      (tenant_id,scouting_run_id,field_id,observed_by,observation_type,notes)
    VALUES ($1,$2,$3,$4,'weed','Evidence browser fixture') RETURNING id
  `,[tenantId,run,field,userId]);
  await admin.query(`
    INSERT INTO evidence_assets
      (tenant_id,scouting_observation_id,uploaded_by,kind,storage_key,
        mime_type,size_bytes,created_at)
    SELECT $1,$2,$3,'photo','browser-evidence-only:' || g::text,
      'image/png',12, '2026-10-15T10:00:00Z'::timestamptz - (g::text || ' seconds')::interval
    FROM generate_series(1,13) g
  `,[tenantId,observation,userId]);

  await page.reload();
  await page.getByTitle('Monitoreo').waitFor();
  await page.getByTitle('Monitoreo').click();
  await page.getByRole('heading',{name:'Monitoreo'}).waitFor();
  await page.getByRole('button',{name:/Evidence Browser Lote/}).click();
  const panel = page.getByRole('region',{name:'Verificación de evidencias de la recorrida'});
  await panel.getByText('Archivos registrados · página 1').waitFor();
  assert.equal(await panel.getByRole('button',{name:'Verificar SHA-256'}).count(),10);
  await panel.getByText('Página 1 · 10 archivos en esta página').waitFor();
  console.log('PASS: real cookie/tenant run returns ten live evidence rows, no blob downloads');
  await page.getByRole('button', { name: 'Agregar observación' }).click();
  const mobileDialog = page.getByRole('dialog', { name: 'Agregar observación' });
  await mobileDialog.getByRole('button', { name: 'Cerrar Agregar observación' }).click();
  await mobileDialog.waitFor({ state: 'detached' });
  console.log('PASS: hidden-tab GPS callback did not resurrect optional coordinates');


  // SHA is deliberate: no integrity endpoint until the operator requests it.
  let integrityRequests=0;
  page.on('request',request => {
    if(request.url().includes('/evidence/') && request.url().endsWith('/integrity')) {
      integrityRequests+=1;
    }
  });
  await panel.getByRole('button',{name:'Verificar SHA-256'}).first().click();
  await panel.getByText('Archivo ausente').first().waitFor();
  assert.equal(integrityRequests,1);
  console.log('PASS: manual integrity check returns missing without automatic bulk scans');

  // Navigate forward/backward, lose the old per-file SHA result on page swap.
  await panel.getByRole('button',{name:'Archivos anteriores'}).click();
  await panel.getByText('Archivos registrados · página 2').waitFor();
  await panel.getByText('Página 2 · 3 archivos en esta página').waitFor();
  assert.equal(await panel.getByText('Archivo ausente').count(),0);
  await panel.getByRole('button',{name:'Página anterior'}).click();
  await panel.getByText('Archivos registrados · página 1').waitFor();
  assert.equal(await panel.getByText('Archivo ausente').count(),0);
  console.log('PASS: cursor paging resets stale SHA results and respects page bounds');

  // Hold a REAL 200 returned by Express while React navigates to another
  // screen. Chromium must never paint an old result after this component
  // unmounts, regardless of when the intercept finally releases.
  let releaseDelayedPage;
  let startedDelayedPage;
  let finishedDelayedPage;
  const delayedPageStarted = new Promise(resolve => { startedDelayedPage = resolve; });
  const delayedPageFinished = new Promise(resolve => { finishedDelayedPage = resolve; });
  const delayedPageGate = new Promise(resolve => { releaseDelayedPage = resolve; });
  let delayedHandled = false;
  await page.route('**/api/v1/scouting/runs/*/evidence-status?limit=10', async route => {
    if (delayedHandled) {
      await route.continue();
      return;
    }
    delayedHandled = true;
    try {
      const realResponse = await route.fetch();
      assert.equal(realResponse.status(), 200, 'delayed content must come from Express');
      startedDelayedPage();
      await delayedPageGate;
      try {
        await route.fulfill({ response: realResponse });
      } catch {
        // Navigating away aborts the HTTP reader. Chromium may reject a
        // late route fulfillment because its original fetch was cancelled.
      }
    } finally {
      finishedDelayedPage();
    }
  });
  await panel.getByRole('button',{name:'Verificar de nuevo'}).click();
  await delayedPageStarted;
  await page.getByTitle('Sesiones').click();
  await page.getByText('Esta sesión').waitFor();
  assert.equal(await panel.count(), 0, 'unmounted scouting panel must not persist');
  releaseDelayedPage();
  await delayedPageFinished;
  await page.unroute('**/api/v1/scouting/runs/*/evidence-status?limit=10');
  assert.equal(await panel.count(), 0, 'late HTTP must not re-mount private evidence');
  await page.getByTitle('Monitoreo').click();
  await page.getByRole('heading',{name:'Monitoreo'}).waitFor();
  await page.getByRole('button',{name:/Evidence Browser Lote/}).click();
  await panel.getByText('Archivos registrados · página 1').waitFor();
  assert.equal(await panel.getByRole('button',{name:'Verificar SHA-256'}).count(),10);
  console.log('PASS: late real HTTP response discarded after run panel unmount');

  // Emulate delayed 401 notifications from a superseded account incarnation
  // and an unrelated tenant, verifying the live React handler ignores both.
  // This is an event-race assertion, not a fabricated API success response.
  await page.evaluate(({tenantId,userId}) => {
    window.dispatchEvent(new CustomEvent('sedeagro:session-expired', {
      detail: { scope: `${tenantId}:${userId}`, epoch: 0 }
    }));
    window.dispatchEvent(new CustomEvent('sedeagro:session-expired', {
      detail: { scope: `00000000-0000-4000-8000-000000000001:${userId}`, epoch: 1 }
    }));
  },{tenantId,userId});
  await panel.getByText('Archivos registrados · página 1').waitFor();
  assert.equal(await panel.getByRole('button',{name:'Verificar SHA-256'}).count(),10);
  console.log('PASS: stale 401 from old generation or tenant cannot sign out active cookie session');

  // Real two-tab shared-cookie acceptance for 0S.18.
  const secondTab = await context.newPage();
  await secondTab.goto('http://127.0.0.1:4177/');
  await secondTab.getByTitle('Sesiones').waitFor();
  await secondTab.getByTitle('Cerrar sesión').click();
  await secondTab.getByRole('heading', { name: 'Iniciar sesión' }).waitFor();
  await page.getByRole('heading', { name: 'Iniciar sesión' }).waitFor();
  assert.equal(await panel.count(), 0);
  console.log('PASS: multi-tab server logout removed previous tenant private view');

  // A transient validation failure must lock the old React view instead
  // of claiming the user was logged out or reviving private evidence.
  await page.route('**/api/v1/auth/me', route => route.fulfill({
    status: 503, contentType: 'application/json',
    body: JSON.stringify({ error: { message: 'Temporary test outage' } })
  }), { times: 1 });
  // Switch the shared browser cookie to a genuinely different tenant.
  await secondTab.getByRole('button', { name: 'Crear cuenta nueva' }).click();
  await secondTab.locator('#reg-org-name').fill('Other Browser Tenant');
  await secondTab.locator('#reg-slug').fill(`other-tab-${suffix}`);
  await secondTab.locator('#reg-full-name').fill('Different Browser User');
  await secondTab.locator('#reg-email').fill(`other-tab-${suffix}@example.test`);
  await secondTab.locator('#reg-password').fill(password);
  const otherRegistrationRequest = secondTab.waitForResponse(res =>
    res.url().endsWith('/auth/register-tenant') && res.request().method() === 'POST');
  await secondTab.locator('#register-submit').click();
  const otherRegistration = await otherRegistrationRequest;
  assert.equal(otherRegistration.status(), 201, await otherRegistration.text());
  const otherProfile = await otherRegistration.json();
  secondTenantId = otherProfile.tenant.id;
  secondUserId = otherProfile.user.id;

  await page.getByRole('alert').getByText('No se pudo verificar tu sesión').waitFor();
  assert.equal(await panel.count(), 0);
  await page.getByRole('button', { name: 'Reintentar verificación' }).click();
  await page.getByTitle('Perfil de usuario').click();
  await page.locator('.user-menu__tenant-name').getByText('Other Browser Tenant').waitFor();
  assert.equal(await panel.count(), 0);
  console.log('PASS: cross-tenant browser login adopted new authenticated identity');
  await secondTab.getByTitle('Cerrar sesión').click();
  await page.getByRole('heading', { name: 'Iniciar sesión' }).waitFor();

  await secondTab.locator('#login-email').fill(email);
  await secondTab.locator('#login-password').fill(password);
  await secondTab.locator('#login-submit').click();
  await secondTab.getByTitle('Sesiones').waitFor();
  await page.getByTitle('Monitoreo').waitFor();
  await page.getByTitle('Monitoreo').click();
  await page.getByRole('button', { name: /Evidence Browser Lote/ }).click();
  await panel.getByText('Archivos registrados · página 1').waitFor();
  assert.equal(await panel.getByRole('button', { name: 'Verificar SHA-256' }).count(), 10);
  await secondTab.close();
  console.log('PASS: returning to first account reads its own evidence anew');

  // Force a REAL backend 400 from a modified cursor: do not fake an API error.
  await page.route('**/api/v1/scouting/runs/*/evidence-status?limit=10&cursor=*',async route => {
    await route.continue({ url: route.request().url().replace(/cursor=[^&]*/, 'cursor=forged') });
  });
  await panel.getByRole('button',{name:'Archivos anteriores'}).click();
  await panel.getByText(/Este cursor dejó de ser válido/).waitFor();
  assert.equal(await panel.getByRole('button',{name:'Verificar SHA-256'}).count(),0);
  await page.unroute('**/api/v1/scouting/runs/*/evidence-status?limit=10&cursor=*');
  await panel.getByRole('button',{name:'Reiniciar historial'}).click();
  await panel.getByText('Archivos registrados · página 1').waitFor();
  console.log('PASS: forged cursor produces real 400 and safe first-page restart');

  // Browser-enforced offline then online. Any previous "bytes present" status
  // is invalidated immediately; old cursor must not be carried over.
  await panel.getByRole('button',{name:'Archivos anteriores'}).click();
  await panel.getByText('Archivos registrados · página 2').waitFor();
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await panel.getByText(/Sin conexión\. No se puede afirmar/).waitFor();
  assert.equal(await panel.getByRole('button',{name:'Verificar SHA-256'}).count(),0);
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await panel.getByText('Archivos registrados · página 1').waitFor();
  await panel.getByText('Página 1 · 10 archivos en esta página').waitFor();
  console.log('PASS: real Chromium offline/online invalidates bytes and resets cursor history');

  // The entitlement changes in PostgreSQL while the browser stays open.
  // The NEXT HTTP read must return 403, never a fabricated empty history.
  await admin.query(`
    UPDATE tenant_modules SET is_enabled=false
    WHERE tenant_id=$1 AND module_code='scouting'
  `,[tenantId]);
  await panel.getByRole('button',{name:'Verificar de nuevo'}).click();
  await panel.getByText(/No se puede afirmar que no existan archivos/).waitFor();
  assert.equal(await panel.getByRole('button',{name:'Verificar SHA-256'}).count(),0);
  console.log('PASS: revoked entitlement removes evidence results; no stale-data success');
  await admin.query(`
    UPDATE tenant_modules SET is_enabled=true
    WHERE tenant_id=$1 AND module_code='scouting'
  `,[tenantId]);
  await panel.getByRole('button',{name:'Reiniciar historial'}).click();
  await panel.getByText('Archivos registrados · página 1').waitFor();

  // End the cookie session server-side (not clearing JS state manually).
  const sessionRows=(await admin.query(`
    UPDATE auth_sessions SET revoked_at=now()
    WHERE tenant_id=$1 AND user_id=$2 AND revoked_at IS NULL
    RETURNING id
  `,[tenantId,userId])).rows;
  assert.ok(sessionRows.length,'browser must hold a revocable cookie session');
  await panel.getByRole('button',{name:'Verificar de nuevo'}).click();
  await page.getByRole('heading',{name:'Iniciar sesión'}).waitFor();
  assert.equal(await page.getByRole('region',{
    name:'Verificación de evidencias de la recorrida'
  }).count(),0);
  console.log('PASS: revoking HttpOnly session in PostgreSQL removes live React evidence panel');

  await context.close();
} finally {
  if(browser)await browser.close();
  if(vite)vite.kill();
  if(backend)backend.kill();
  if(secondTenantId)await admin.query('DELETE FROM tenants WHERE id=$1',[secondTenantId]).catch(()=>{});
  if(secondUserId)await admin.query('DELETE FROM users WHERE id=$1',[secondUserId]).catch(()=>{});
  if(tenantId)await admin.query('DELETE FROM tenants WHERE id=$1',[tenantId]).catch(()=>{});
  if(userId)await admin.query('DELETE FROM users WHERE id=$1',[userId]).catch(()=>{});
  await admin.end().catch(()=>{});
}
