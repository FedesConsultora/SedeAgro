// Real RLS membership login-discovery benchmark. Disposable GitHub CI ONLY.
// No staging/prod probing, secrets, emails, tenant UUIDs or SQL in output.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { arch, cpus, platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { isSafeRuntimeDbRole } from '../backend/src/core/tenantDbSafety.js';

export const LOGIN_PERF_FLAG = 'I_ACCEPT_ONLY_DISPOSABLE_MEMBERSHIP_RLS_BENCHMARK';
export const LOGIN_PERF_SCALES = Object.freeze([1, 25, 100, 250]);
export const LOGIN_PERF_SAMPLES = 7;
const DB_TEST = /(?:^|[_-])test(?:$|[_-])/i;
const HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
let phase = 'preflight';

export function assertLoginPerfConfig(env) {
  if (env.CI !== 'true' || env.GITHUB_ACTIONS !== 'true' ||
      env.SEDEAGRO_LOGIN_PERF_PROBE !== LOGIN_PERF_FLAG) {
    throw new Error('BLOCKED: disposable GitHub CI opt-in required');
  }
  let owner, runtime;
  try {
    owner = new URL(env.TEST_DATABASE_ADMIN_URL);
    runtime = new URL(env.TEST_DATABASE_APP_URL);
  } catch {
    throw new Error('BLOCKED: two disposable PostGIS URLs required');
  }
  for (const url of [owner, runtime]) {
    if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
        !HOSTS.has(url.hostname) || !DB_TEST.test(decodeURIComponent(url.pathname.slice(1))) ||
        !url.username || !url.password || url.search || url.hash) {
      throw new Error('BLOCKED: loopback *_test database URLs only');
    }
  }
  if (owner.pathname !== runtime.pathname || owner.hostname !== runtime.hostname ||
      owner.port !== runtime.port || owner.username === runtime.username) {
    throw new Error('BLOCKED: same loopback database with distinct runtime role required');
  }
  return { ownerUrl: env.TEST_DATABASE_ADMIN_URL, runtimeUrl: env.TEST_DATABASE_APP_URL };
}

export function measuredPercentile(values, fraction) {
  if (!Array.isArray(values) || !values.length ||
      values.some(v => !Number.isFinite(v) || v < 0) ||
      !Number.isFinite(fraction) || fraction <= 0 || fraction > 1) {
    throw new Error('Invalid measured latency samples');
  }
  const ordered = [...values].sort((a, b) => a - b);
  return Math.round(ordered[Math.ceil(ordered.length * fraction) - 1] * 1000) / 1000;
}

async function benchmarkRun({ userId, tenantId, tenantSlug, scale, discover }) {
  const collect = async selector => {
    const samples = [];
    for (let attempt = 0; attempt < LOGIN_PERF_SAMPLES + 2; attempt++) {
      const started = performance.now();
      const matches = await discover(userId, selector);
      const duration = performance.now() - started;
      assert.equal(matches.length, 1, 'Exactly one authorized membership expected');
      assert.equal(matches[0].tenant_id, tenantId,
        'RLS login discovery must never substitute another tenant');
      assert.equal(matches[0].role_code, 'scout');
      assert.ok(duration >= 0 && Number.isFinite(duration));
      if (attempt >= 2) samples.push(duration);
    }
    return { p50Ms: measuredPercentile(samples, .5),
      p95Ms: measuredPercentile(samples, .95) };
  };
  const unselected = await collect({});
  const byTenantId = await collect({ tenantId });
  const byTenantSlug = await collect({ tenantSlug });
  console.log('LOGIN_MEMBERSHIP_RLS_PERF=' + JSON.stringify({
    tenants: scale, samples: LOGIN_PERF_SAMPLES,
    unselected, selectedId: byTenantId, selectedSlug: byTenantSlug,
    realPostgres: true, forceRls: true, runtimeNonOwner: true,
    externalStagingCertified: false, productionSloCertified: false
  }));
}

export async function main() {
  const { ownerUrl, runtimeUrl } = assertLoginPerfConfig(process.env);
  process.env.DATABASE_URL = runtimeUrl;
  process.env.NODE_ENV = 'test';
  process.env.LOG_SQL = '0';
  const [{ sequelize }, { discoverLoginMemberships, MAX_LOGIN_DISCOVERY_TENANTS },
    { hashPassword }] = await Promise.all([
    import('../backend/src/core/db.js'),
    import('../backend/src/modules/auth/loginMembershipDiscovery.js'),
    import('../backend/src/utils/password.js')
  ]);
  assert.equal(MAX_LOGIN_DISCOVERY_TENANTS, 250);
  const owner = new pg.Client({ connectionString: ownerUrl });
  const runtime = new pg.Client({ connectionString: runtimeUrl });
  let adminConnected = false, appConnected = false;
  const tenants = [];
  let userId = null;
  try {
    phase = 'connection';
    await owner.connect(); adminConnected = true;
    await runtime.connect(); appConnected = true;
    const [ownerDb, runtimeDb, role] = await Promise.all([
      owner.query('SELECT current_database() AS db'),
      runtime.query('SELECT current_database() AS db'),
      runtime.query("SELECT r.rolname,r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,pg_get_userbyid(d.datdba) AS db_owner FROM pg_roles r JOIN pg_database d ON d.datname=current_database() WHERE r.rolname=current_user")
    ]);
    assert.equal(ownerDb.rows[0].db, runtimeDb.rows[0].db);
    assert.match(ownerDb.rows[0].db, DB_TEST);
    assert.ok(isSafeRuntimeDbRole(role.rows[0]), 'runtime DB role must not bypass RLS');
    const rls = await owner.query(
      "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='public.memberships'::regclass");
    assert.deepEqual(rls.rows, [{relrowsecurity:true,relforcerowsecurity:true}]);
    const existing = await owner.query(
      "SELECT count(*)::int AS n FROM tenants WHERE status IN ('active','onboarding')");
    assert.equal(existing.rows[0].n, 0,
      'Only an empty isolated synthetic catalog can measure 1/25/100/250');
    const plan = await owner.query("SELECT id FROM plans WHERE code='starter'");
    assert.equal(plan.rows.length, 1);
    const suffix = randomUUID().replaceAll('-', '').slice(0, 14);
    const email = 'login-perf-' + suffix + '@example.test';
    const passwordHash = await hashPassword('OnlyForDisposablePerf-2026!');
    const user = await owner.query(
      'INSERT INTO users(email,full_name,password_hash) VALUES($1,$2,$3) RETURNING id',
      [email, 'Disposable login performance actor', passwordHash]);
    userId = user.rows[0].id;
    let earlier = 0, firstId, firstSlug;
    console.log('LOGIN_MEMBERSHIP_RLS_ENV=' + JSON.stringify({
      os: platform(), arch: arch(), logicalCpus: cpus().length,
      node: process.version, postgres: (await runtime.query('SHOW server_version')).rows[0].server_version,
      scales: LOGIN_PERF_SCALES, samples: LOGIN_PERF_SAMPLES
    }));
    for (const scale of LOGIN_PERF_SCALES) {
      phase = 'seed-' + scale;
      for (let n = earlier + 1; n <= scale; n++) {
        const slug = 'login-perf-' + suffix + '-' + n;
        const record = await owner.query(
          "INSERT INTO tenants(plan_id,name,slug,status) VALUES($1,$2,$3,'active') RETURNING id",
          [plan.rows[0].id, 'Synthetic RLS tenant ' + n, slug]);
        tenants.push(record.rows[0].id);
        if (n === 1) { firstId = record.rows[0].id; firstSlug = slug; }
      }
      if (scale === 1) {
        await owner.query(
          "INSERT INTO memberships(tenant_id,user_id,role_code,status) VALUES($1,$2,'scout','active')",
          [firstId,userId]);
      }
      await owner.query('ANALYZE tenants');
      await owner.query('ANALYZE memberships');
      const count = await owner.query(
        "SELECT count(*)::int AS n FROM tenants WHERE status IN ('active','onboarding')");
      assert.equal(count.rows[0].n, scale);
      const noContext = await runtime.query('SELECT id FROM memberships WHERE user_id=$1', [userId]);
      assert.equal(noContext.rowCount, 0, 'no-tenant runtime RLS must reveal zero membership rows');
      phase = 'measure-' + scale;
      await benchmarkRun({userId,tenantId:firstId,tenantSlug:firstSlug,scale,
        discover:discoverLoginMemberships});
      earlier = scale;
    }
    phase = 'over-limit';
    const extra = await owner.query(
      "INSERT INTO tenants(plan_id,name,slug,status) VALUES($1,$2,$3,'active') RETURNING id",
      [plan.rows[0].id,'Synthetic RLS tenant 251','login-perf-'+suffix+'-251']);
    tenants.push(extra.rows[0].id);
    await assert.rejects(() => discoverLoginMemberships(userId),
      error => error?.status === 503 && error?.code === 'LOGIN_DISCOVERY_CAPACITY_LIMIT');
    const selected = await discoverLoginMemberships(userId,{tenantId:firstId});
    assert.equal(selected.length,1);
    assert.equal(selected[0].tenant_id,firstId);
    console.log('LOGIN_MEMBERSHIP_CAPACITY=' + JSON.stringify({
      tenants:251, unselected:'BLOCKED_503', selected:'AUTHORIZED_ONE',
      partialTenantChoicesExposed:false, productionSloCertified:false
    }));
  } finally {
    phase='cleanup';
    try {
      if (adminConnected) {
        if (tenants.length) await owner.query(
          'DELETE FROM tenants WHERE id=ANY($1::uuid[])', [tenants]);
        if (userId) await owner.query('DELETE FROM users WHERE id=$1',[userId]);
      }
    } finally {
      if (appConnected) await runtime.end();
      if (adminConnected) await owner.end();
      await sequelize.close();
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => {
    // Do not serialize PII, passwords, SQL, URLs or untrusted exception messages.
    console.error('BLOCKED login membership RLS performance [' +
      phase.replace(/[^a-z0-9-]/g,'') + ']: ' +
      String(error?.code || error?.name || 'ERROR').replace(/[^a-zA-Z0-9_]/g,''));
    process.exitCode=2;
  });
}
