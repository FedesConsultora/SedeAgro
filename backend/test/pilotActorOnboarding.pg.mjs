// 0U/ENT-01+03 -> SC-01: the first live pilot journey entirely over HTTP.
// Unlike pilotCriticalPath.pg.mjs, this test does not seed tenant, users,
// membership, producer, farm, field, campaign or scouting run via owner SQL.
// Only global catalogs/seeds and final independent SQL evidence are read.
// Real cookie sessions + real PostGIS non-owner runtime; NOT a device test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const ownerUrl = process.env.TEST_DATABASE_ADMIN_URL;
const runtimeUrl = process.env.TEST_DATABASE_APP_URL;
if (!ownerUrl || !runtimeUrl) {
  throw new Error('pilotActorOnboarding requires disposable *_test PostGIS owner+runtime URLs');
}
process.env.DATABASE_URL = runtimeUrl;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'disposable-pilot-actor-journey-only';

const { createApp } = await import('../src/app.js');
const { sequelize } = await import('../src/core/db.js');
const { isSafeRuntimeDbRole } = await import('../src/core/tenantDbSafety.js');

test('ENT-01/03 -> SC-01: real founder registration, invitations, roles, GIS, campaign and assigned run', async t => {
  const owner = new pg.Client({ connectionString: ownerUrl });
  const runtime = new pg.Client({ connectionString: runtimeUrl });
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await sequelize.close();
  });
  const origin = 'http://127.0.0.1:' + server.address().port + '/api/v1';
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const tenants = [], users = [];
  const password = 'TestPilotActorStrong2026!';
  const scoutPassword = 'ScoutFieldSecure2026!';
  const producerPassword = 'ProducerFieldSecure2026!';
  let ownerReady = false, runtimeReady = false;

  async function request(path, { method = 'GET', actor, body,
    requestHeader = true } = {}) {
    const response = await fetch(origin + path, {
      method,
      headers: {
        ...(actor?.cookie ? { cookie: actor.cookie, 'x-tenant-id': actor.tenant } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(['GET', 'HEAD'].includes(method) || !requestHeader
          ? {} : { 'x-sedeagro-request': '1' }),
        ...(!actor && path.startsWith('/auth/') && (
          path === '/auth/login' || path === '/auth/register-tenant')
          ? { 'x-sedeagro-session': 'cookie' } : {})
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    const raw = await response.text();
    const parsed = raw ? JSON.parse(raw) : null;
    return {
      status: response.status, json: parsed,
      cache: response.headers.get('cache-control'),
      setCookie: response.headers.get('set-cookie')
    };
  }

  function check(result, status, label) {
    assert.equal(result.status, status,
      label + ': expected HTTP ' + status + ', got ' + result.status +
      (result.json?.error?.code ? ' (' + result.json.error.code + ')' : ''));
    return result.json;
  }

  function cookieSession(response, label) {
    assert.ok(response.setCookie?.startsWith('sedeagro_session='),
      label + ': server must issue cookie');
    assert.match(response.setCookie, /; HttpOnly;/);
    assert.match(response.setCookie, /; SameSite=Strict/);
    assert.doesNotMatch(JSON.stringify(response.json), /eyJ[A-Za-z0-9_-]{20,}/,
      label + ': cookie session must not expose bearer JWT in JSON');
    return {
      cookie: response.setCookie.split(';', 1)[0],
      tenant: response.json.tenant.id,
      user: response.json.user.id,
      membership: response.json.membership.id
    };
  }

  async function founder(tag) {
    const email = 'pilot-actor-admin-' + tag + '-' + suffix + '@example.test';
    const slug = 'pilot-actor-' + tag + '-' + suffix;
    const response = await request('/auth/register-tenant', {
      method: 'POST',
      body: {
        organizationName: 'Pilot actor company ' + tag,
        slug, fullName: 'Pilot Founder ' + tag,
        email, password, planCode: 'starter'
      }
    });
    check(response, 201, 'register company ' + tag);
    const actor = cookieSession(response, 'registered founder ' + tag);
    tenants.push(actor.tenant);
    users.push(actor.user);
    assert.equal(response.json.membership.roleCode, 'tenant_admin');
    for (const entitlement of ['org', 'gis', 'campaigns', 'scouting', 'work_orders', 'reports']) {
      assert.ok(response.json.entitlements.includes(entitlement),
        'starter registration should persist ' + entitlement);
    }
    return { ...actor, email, password };
  }

  async function inviteAndAccept(admin, role, name, recipientPassword) {
    const email = 'pilot-' + role + '-' + suffix + '@example.test';
    const issued = await request('/auth/invitations', {
      actor: admin, method: 'POST', body: { email, roleCode: role }
    });
    check(issued, 201, 'invite ' + role);
    assert.equal(issued.json.delivery.channel, 'manual');
    assert.equal(issued.json.delivery.delivered, false);
    const secret = issued.json.delivery.token;
    assert.equal(typeof secret, 'string');
    assert.ok(secret.startsWith(admin.tenant + '.'));
    const list = await request('/auth/invitations', { actor: admin });
    check(list, 200, 'invite list');
    assert.ok(list.json.data.some(row => row.id === issued.json.data.id));
    assert.ok(!JSON.stringify(list.json).includes(secret),
      'list endpoint must never leak secret token');
    const accepted = await request('/auth/invite/accept', {
      method: 'POST', body: { token: secret, password: recipientPassword, fullName: name }
    });
    check(accepted, 201, 'accept ' + role);
    assert.equal(accepted.json.data.tenant.id, admin.tenant);
    assert.equal(accepted.json.data.roleCode, role);
    check(await request('/auth/invite/accept', {
      method: 'POST', body: { token: secret, password: recipientPassword, fullName: name }
    }), 410, 'token is single use');
    const login = await request('/auth/login', {
      method: 'POST', body: { email, password: recipientPassword, tenantId: admin.tenant }
    });
    check(login, 200, 'login accepted ' + role);
    assert.equal(login.json.membership.roleCode, role);
    const actor = cookieSession(login, 'accepted ' + role);
    assert.equal(actor.tenant, admin.tenant);
    users.push(actor.user);
    check(await request('/auth/me', { actor }), 200, 'persistent session ' + role);
    return { ...actor, email };
  }

  try {
    await owner.connect(); ownerReady = true;
    await runtime.connect(); runtimeReady = true;
    const [{ db }] = (await owner.query('SELECT current_database() AS db')).rows;
    const [{ app_db, ...role }] = (await runtime.query(
      'SELECT current_database() AS app_db,r.rolname,r.rolsuper,r.rolbypassrls,' +
      'r.rolcreaterole,r.rolcreatedb,pg_get_userbyid(d.datdba) AS db_owner ' +
      'FROM pg_roles r JOIN pg_database d ON d.datname=current_database() ' +
      'WHERE r.rolname=current_user'
    )).rows;
    assert.match(db, /(?:^|[_-])test(?:$|[_-])/i);
    assert.equal(app_db, db);
    assert.ok(isSafeRuntimeDbRole(role), 'HTTP app must run as non-owner without bypassrls');
    for (const table of ['memberships', 'farms', 'fields', 'campaigns',
      'campaign_fields', 'scouting_runs', 'member_invitations']) {
      const [{ relrowsecurity, relforcerowsecurity }] = (await owner.query(
        'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',
        ['public.' + table]
      )).rows;
      assert.ok(relrowsecurity && relforcerowsecurity, table + ' must FORCE RLS');
    }

    const admin = await founder('a');
    const outsider = await founder('b');
    assert.notEqual(admin.tenant, outsider.tenant);
    const scout = await inviteAndAccept(admin, 'scout', 'Real Field Scout', scoutPassword);
    const producer = await inviteAndAccept(admin, 'producer_viewer',
      'Real Producer', producerPassword);

    // A valid session still cannot mutate a cookie-authenticated endpoint
    // without a non-simple CSRF request header. There must be no side effect.
    const refused = await request('/farms/producers', {
      actor: admin, method: 'POST', requestHeader: false,
      body: { name: 'Forbidden CSRF Producer ' + suffix }
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.json.error.code, 'CSRF_HEADER_REQUIRED');

    // All pilot business objects below are created through real HTTP API.
    const producerRow = check(await request('/farms/producers', {
      actor: admin, method: 'POST', body: { name: 'Soy producer ' + suffix }
    }), 201, 'real producer creation').data;
    const foreignProducer = check(await request('/farms/producers', {
      actor: outsider, method: 'POST', body: { name: 'Foreign producer ' + suffix }
    }), 201, 'foreign tenant producer').data;

    const farmBody = {
      producer_id: producerRow.id, name: 'Campo Piloto ' + suffix,
      province: 'Buenos Aires', locality: 'La Plata'
    };
    check(await request('/farms', {
      actor: admin, method: 'POST', body: { ...farmBody, producer_id: foreignProducer.id }
    }), 404, 'foreign producer cannot be linked');
    const farm = check(await request('/farms', {
      actor: admin, method: 'POST', body: farmBody
    }), 201, 'real farm').data;
    const farmReplay = check(await request('/farms', {
      actor: admin, method: 'POST', body: farmBody
    }), 200, 'same farm creation replay');
    assert.equal(farmReplay.data.id, farm.id);

    const boundary = { type: 'Polygon', coordinates: [[
      [-57.953, -34.922], [-57.949, -34.922],
      [-57.949, -34.918], [-57.953, -34.918],
      [-57.953, -34.922]
    ]] };
    check(await request('/fields', {
      actor: admin, method: 'POST', body: {
        farm_id: farm.id, name: 'Invalid ring ' + suffix,
        boundary: { type: 'Polygon', coordinates: [[
          [-57.953,-34.922],[-57.949,-34.918],[-57.949,-34.922],
          [-57.953,-34.918],[-57.953,-34.922]
        ]] }
      }
    }), 422, 'self-intersecting lot polygon rejected');
    check(await request('/fields', {
      actor: scout, method: 'POST', body: { farm_id: farm.id, name: 'Unprivileged Lot' }
    }), 403, 'scout cannot create farm lot');
    const field = check(await request('/fields', {
      actor: admin, method: 'POST', body: {
        farm_id: farm.id, name: 'Lote Norte ' + suffix,
        area_hectares: 12.5, boundary
      }
    }), 201, 'real GIS field').data;
    assert.equal(field.farm_id, farm.id);
    check(await request('/fields/' + field.id, { actor: outsider }),
      404, 'foreign tenant field is opaque');

    const cropCatalog = check(await request('/catalogs/bootstrap', {
      actor: admin
    }), 200, 'catalog').cropTypes;
    const soy = cropCatalog.find(row => row.code === 'soy');
    assert.ok(soy?.id, 'global crop catalog is required');
    const campaignPayload = {
      client_request_id: randomUUID(),
      name: 'Campana soja ' + suffix,
      season_year: 2026, starts_at: '2026-09-01', ends_at: '2027-03-31'
    };
    check(await request('/campaigns', {
      actor: scout, method: 'POST', body: campaignPayload
    }), 403, 'scout cannot create campaign');
    const campaign = check(await request('/campaigns', {
      actor: admin, method: 'POST', body: campaignPayload
    }), 201, 'real campaign').data;
    const replayCampaign = check(await request('/campaigns', {
      actor: admin, method: 'POST', body: campaignPayload
    }), 200, 'exact campaign ACK replay');
    assert.equal(replayCampaign.data.id, campaign.id);
    assert.equal(replayCampaign.replayed, true);

    const assignmentPayload = {
      client_request_id: randomUUID(), field_id: field.id,
      crop_type_id: soy.id, planting_date: '2026-10-01',
      harvest_target_date: '2027-02-15'
    };
    const campaignField = check(await request(
      '/campaigns/' + campaign.id + '/fields', {
        actor: admin, method: 'POST', body: assignmentPayload
      }), 201, 'assign field to campaign').data;
    const replayField = check(await request(
      '/campaigns/' + campaign.id + '/fields', {
        actor: admin, method: 'POST', body: assignmentPayload
      }), 200, 'exact field assignment ACK replay');
    assert.equal(replayField.data.id, campaignField.id);
    check(await request('/campaigns/' + campaign.id + '/fields', {
      actor: outsider, method: 'POST', body: assignmentPayload
    }), 404, 'cross-tenant campaign assignment denied');

    const scoutingPayload = {
      client_request_id: randomUUID(), campaign_field_id: campaignField.id,
      assigned_to: scout.user, status: 'in_progress',
      summary: 'Real HTTP onboarding to first field visit'
    };
    const run = check(await request('/scouting/runs', {
      actor: admin, method: 'POST', body: scoutingPayload
    }), 201, 'assigned run').data;
    const replayRun = check(await request('/scouting/runs', {
      actor: admin, method: 'POST', body: scoutingPayload
    }), 200, 'exact run ACK replay');
    assert.equal(run.id, replayRun.data.id);
    const scopedRun = check(await request('/scouting/runs/' + run.id, {
      actor: scout
    }), 200, 'scout can read assigned run').data;
    assert.equal(scopedRun.assigned_to, scout.user);
    assert.equal(scopedRun.campaign_field_id, campaignField.id);
    check(await request('/scouting/runs/' + run.id, {
      actor: outsider
    }), 404, 'foreign tenant cannot read run');

    // Producer cannot view the field before an explicit grant and cannot
    // acquire campaign/scouting privileges just by having a cookie.
    const preGrant = check(await request('/fields', { actor: producer }),
      200, 'producer fields before grant').data;
    assert.equal(preGrant.some(row => row.id === field.id), false);
    check(await request('/campaigns', { actor: producer }),
      403, 'producer cannot read internal campaign');
    check(await request('/scouting/runs/' + run.id, { actor: producer }),
      403, 'producer cannot read scouting run');
    check(await request('/farms/producers/' + producerRow.id + '/access', {
      actor: scout, method: 'POST', body: { user_id: producer.user }
    }), 403, 'scout cannot grant producer visibility');
    check(await request('/farms/producers/' + producerRow.id + '/access', {
      actor: admin, method: 'POST', body: { user_id: producer.user }
    }), 201, 'grant producer lot access');
    const visible = check(await request('/fields', { actor: producer }),
      200, 'producer sees only granted fields').data;
    assert.equal(visible.some(row => row.id === field.id), true);
    check(await request('/farms/producers/' + producerRow.id +
      '/access/' + producer.user, { actor: admin, method: 'DELETE' }),
    204, 'revoke producer access');
    const afterGrantRevoked = check(await request('/fields', {
      actor: producer
    }), 200, 'producer grants revoked').data;
    assert.equal(afterGrantRevoked.some(row => row.id === field.id), false);

    // The same issued cookie is invalid after the admin blocks the scout;
    // a cached JWT or draft ID must not reauthorize another API request.
    check(await request('/auth/members/' + scout.membership + '/status', {
      actor: admin, method: 'PATCH', body: { status: 'blocked' }
    }), 200, 'block scout');
    check(await request('/auth/me', { actor: scout }),
      401, 'revoked scout login cookie');
    check(await request('/scouting/runs/' + run.id, { actor: scout }),
      401, 'revoked scout has no assigned run API');

    // Evidence of one persisted actor chain and no duplicate replays.
    const row = (await owner.query(
      'SELECT f.tenant_id, c.id AS campaign_id, cf.id AS link_id,' +
      ' r.assigned_to, m.status AS scout_status ' +
      'FROM fields f JOIN campaign_fields cf ON cf.field_id=f.id ' +
      'JOIN campaigns c ON c.id=cf.campaign_id ' +
      'JOIN scouting_runs r ON r.campaign_field_id=cf.id ' +
      'JOIN memberships m ON m.user_id=r.assigned_to AND m.tenant_id=f.tenant_id ' +
      'WHERE f.id=$1 AND r.id=$2', [field.id, run.id]
    )).rows;
    assert.equal(row.length, 1);
    assert.equal(row[0].tenant_id, admin.tenant);
    assert.equal(row[0].campaign_id, campaign.id);
    assert.equal(row[0].link_id, campaignField.id);
    assert.equal(row[0].assigned_to, scout.user);
    assert.equal(row[0].scout_status, 'blocked');

    // Real non-owner PostGIS client cannot access another tenant even
    // when a leaked UUID has the correct shape.
    for (const [tenantId, expected] of [[admin.tenant, 1], [outsider.tenant, 0]]) {
      await runtime.query('BEGIN');
      try {
        await runtime.query("SELECT set_config('app.current_tenant',$1,true)", [tenantId]);
        const sql = await runtime.query(
          'SELECT count(*)::int AS n FROM scouting_runs WHERE id=$1',
          [run.id]
        );
        assert.equal(sql.rows[0].n, expected);
      } finally { await runtime.query('ROLLBACK'); }
    }

  } finally {
    if (runtimeReady) await runtime.end();
    if (ownerReady) {
      try {
        if (tenants.length) await owner.query(
          'DELETE FROM tenants WHERE id=ANY($1::uuid[])', [tenants]);
        if (users.length) await owner.query(
          'DELETE FROM users WHERE id=ANY($1::uuid[])', [users]);
      } finally { await owner.end(); }
    }
  }
});
