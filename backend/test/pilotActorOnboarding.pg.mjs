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

test('0U full HTTP actor chain: founder -> invitations -> GPS evidence -> contractor -> independent review -> reports', async t => {
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
  const contractorPassword = 'ContractorFieldSecure2026!';
  const coordinatorPassword = 'CoordinatorFieldSecure2026!';
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
    const contractor = await inviteAndAccept(admin, 'contractor',
      'Real Contractor', contractorPassword);
    const coordinator = await inviteAndAccept(admin, 'agronomic_coordinator',
      'Real Coordinator', coordinatorPassword);
    assert.equal(new Set([admin.user, scout.user, producer.user,
      contractor.user, coordinator.user]).size, 5,
      'reviewer and executor must never be the same actor');
    check(await request('/auth/me', { actor: contractor }), 200,
      'fresh persisted contractor session');

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
    // The invited real scout, not an owner-SQL synthetic principal, now
    // persists the first observation with authored WGS84 GPS via the SAME
    // offline batch API used by the PWA. A lost HTTP ACK replays exactly once.
    const gps = { type: 'Point', coordinates: [-57.9521, -34.9205] };
    const observationBatch = {
      client_id: 'sedeagro-web-offline-v1',
      idempotency_key: randomUUID(),
      operations: [{
        entity_type: 'scouting_observation', entity_client_id: randomUUID(),
        operation: 'create', payload: {
          scouting_run_id: run.id, observation_type: 'pest',
          severity: 'high', observed_at: new Date().toISOString(),
          notes: 'HTTP integrated first field scouting concern ' + suffix,
          point: gps
        }
      }]
    };
    const observationResult = check(await request('/sync/batches', {
      actor: scout, method: 'POST', body: observationBatch
    }), 201, 'invited scout submits offline GPS batch');
    const observationId = observationResult.data.operations[0].result.observation_id;
    assert.ok(observationId, 'offline batch must persist an observation id');
    const observationReplay = check(await request('/sync/batches', {
      actor: scout, method: 'POST', body: observationBatch
    }), 200, 'lost ACK exact offline replay');
    assert.equal(observationReplay.replayed, true);
    assert.equal(observationReplay.data.operations[0].result.observation_id, observationId);
    check(await request('/sync/batches', {
      actor: contractor, method: 'POST', body: observationBatch
    }), 403, 'contractor cannot replay scout offline batch');
    check(await request('/scouting/runs/' + run.id, {
      actor: contractor
    }), 403, 'contractor cannot read scouting run');

    // JPEG fixture is intentionally minimal and non-personal; its bytes are
    // stored and returned by the actual private PostGIS evidence endpoint.
    const imageBytes = Buffer.from('ffd8ffdb0000000000', 'hex');
    const observationFile = {
      kind: 'photo', mime_type: 'image/jpeg',
      original_name: 'cultivo-evidencia.jpg',
      content_base64: imageBytes.toString('base64'),
      client_upload_id: randomUUID()
    };
    const privateObservation = check(await request(
      '/scouting/observations/' + observationId + '/evidence', {
        actor: scout, method: 'POST', body: observationFile
      }), 201, 'scout uploads private JPEG').data;
    assert.ok(privateObservation.id);
    const uploadReplay = check(await request(
      '/scouting/observations/' + observationId + '/evidence', {
        actor: scout, method: 'POST', body: observationFile
      }), 200, 'lost photo ACK replay').data;
    assert.equal(uploadReplay.id, privateObservation.id);
    check(await request('/scouting/evidence/' + privateObservation.id + '/content', {
      actor: outsider
    }), 404, 'foreign company cannot read private scouting file');
    const photoRead = check(await request(
      '/scouting/evidence/' + privateObservation.id + '/content', {
        actor: scout
      }), 200, 'scout reopens private photograph').data;
    assert.equal(photoRead.content_base64, observationFile.content_base64);


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
    // Connect the actual HTTP-created lot/campaign and GPS observation to
    // an operational work order. The schema does NOT claim an observation FK:
    // the authoritative common context is field_id + campaign_field_id.
    const orderBody = {
      client_request_id: randomUUID(), field_id: field.id,
      campaign_field_id: campaignField.id,
      type: 'inspection', priority: 'high',
      title: 'Inspeccionar incidencia GPS ' + suffix,
      instructions: 'Inspeccionar el lote que registra la observación de la recorrida'
    };
    check(await request('/work-orders', {
      actor: scout, method: 'POST', body: orderBody
    }), 403, 'scout cannot authorize work orders');
    const order = check(await request('/work-orders', {
      actor: admin, method: 'POST', body: orderBody
    }), 201, 'admin creates order in observed field').data;
    assert.equal(order.field_id, field.id);
    assert.equal(order.campaign_field_id, campaignField.id);
    const orderReplay = check(await request('/work-orders', {
      actor: admin, method: 'POST', body: orderBody
    }), 200, 'exact work order ACK replay');
    assert.equal(orderReplay.data.id, order.id);
    assert.equal(orderReplay.replayed, true);

    check(await request('/work-orders/' + order.id, { actor: contractor }),
      404, 'invited contractor cannot see unassigned order');
    check(await request('/work-orders/' + order.id, { actor: outsider }),
      404, 'foreign company cannot see order');

    const assigned = check(await request('/work-orders/' + order.id + '/assignees', {
      actor: admin, method: 'POST',
      body: { user_id: contractor.user, responsibility: 'executor' }
    }), 201, 'assign invited contractor').data;
    assert.equal(assigned.user_id, contractor.user);
    const assignedReplay = check(await request('/work-orders/' + order.id + '/assignees', {
      actor: admin, method: 'POST',
      body: { user_id: contractor.user, responsibility: 'executor' }
    }), 200, 'assignment replay').data;
    assert.equal(assignedReplay.id, assigned.id);
    const assignedList = check(await request('/work-orders', {
      actor: contractor
    }), 200, 'contractor sees only own assignments').data;
    assert.equal(assignedList.filter(item => item.id === order.id).length, 1);
    check(await request('/work-orders/' + order.id, {
      actor: contractor
    }), 200, 'contractor can open assigned order');

    // Contractor cannot start a draft and coordinator cannot mark an
    // unreviewed order completed, even with an authenticated cookie.
    check(await request('/work-orders/' + order.id + '/status', {
      actor: contractor, method: 'PATCH', body: { status: 'in_progress' }
    }), 403, 'contractor cannot start a draft order');
    for (const status of ['pending_approval', 'approved', 'assigned']) {
      check(await request('/work-orders/' + order.id + '/status', {
        actor: admin, method: 'PATCH', body: { status }
      }), 200, 'admin advances order to ' + status);
    }
    const approvedOrder = check(await request('/work-orders/' + order.id, {
      actor: contractor
    }), 200, 'contractor sees approved order').data;
    const approvedAt = Date.parse(approvedOrder.approved_at);
    assert.ok(Number.isFinite(approvedAt));
    check(await request('/work-orders/' + order.id + '/status', {
      actor: contractor, method: 'PATCH', body: { status: 'in_progress' }
    }), 200, 'assigned contractor starts work');
    check(await request('/work-orders/' + order.id + '/status', {
      actor: admin, method: 'PATCH', body: { status: 'completed' }
    }), 409, 'cannot close order without verified work report');

    const finished = approvedAt + 120;
    if (Date.now() <= finished) {
      await new Promise(resolve => setTimeout(resolve, finished - Date.now() + 20));
    }
    const executionBody = {
      started_at: new Date(approvedAt + 10).toISOString(),
      finished_at: new Date(finished).toISOString(),
      worked_area_hectares: 1.25,
      result_summary: 'Trabajo real de inspeccion del lote registrado por el scout'
    };
    const execution = check(await request('/work-orders/' + order.id + '/executions', {
      actor: contractor, method: 'POST', body: executionBody
    }), 201, 'contractor submits real execution report').data;
    assert.equal(execution.submitted_by, contractor.user);
    assert.equal(execution.review_status, 'submitted');
    check(await request('/work-orders/' + order.id + '/executions', {
      actor: contractor, method: 'POST', body: executionBody
    }), 409, 'duplicate execution submission cannot create second pending report');

    const reviewPath = '/work-orders/' + order.id + '/executions/' + execution.id + '/review';
    const review = {
      decision: 'verified', checklist: {
        time_checked: true, area_checked: true, result_checked: true,
        operation_checked: true, evidence_basis: 'reviewed_files'
      }
    };
    check(await request(reviewPath, {
      actor: contractor, method: 'POST', body: review
    }), 403, 'contractor cannot review own execution');
    check(await request(reviewPath, {
      actor: coordinator, method: 'POST', body: review
    }), 409, 'cannot claim reviewed_files without actual private attachment');

    const executionFile = {
      kind: 'photo', mime_type: 'image/jpeg',
      original_name: 'inspeccion-ejecutada.jpg',
      client_upload_id: randomUUID(),
      content_base64: imageBytes.toString('base64')
    };
    const evidencePath = '/work-orders/' + order.id +
      '/executions/' + execution.id + '/evidence';
    check(await request(evidencePath, {
      actor: scout, method: 'POST', body: executionFile
    }), 403, 'scout cannot attach to contractor execution');
    const executionEvidence = check(await request(evidencePath, {
      actor: contractor, method: 'POST', body: executionFile
    }), 201, 'contractor uploads private execution JPEG').data;
    assert.ok(executionEvidence.id);
    const sameUpload = check(await request(evidencePath, {
      actor: contractor, method: 'POST', body: executionFile
    }), 200, 'private execution photo exact ACK replay');
    assert.equal(sameUpload.data.id, executionEvidence.id);
    check(await request(evidencePath, {
      actor: contractor, method: 'POST',
      body: { ...executionFile, original_name: 'altered-name.jpg' }
    }), 409, 'photo idempotency key cannot alias another file');

    const privatePath = '/work-orders/' + order.id +
      '/evidence/' + executionEvidence.id;
    check(await request(privatePath + '/content', {
      actor: outsider
    }), 404, 'foreign company cannot fetch contractor private JPEG');
    const content = check(await request(privatePath + '/content', {
      actor: coordinator
    }), 200, 'coordinator verifies private execution photo').data;
    assert.equal(content.content_base64, executionFile.content_base64);
    const integrity = check(await request(privatePath + '/integrity', {
      actor: coordinator
    }), 200, 'coordinator checks private evidence integrity').data;
    assert.equal(integrity.status, 'verified');

    const queue = check(await request('/work-orders/review-queue', {
      actor: coordinator
    }), 200, 'independent coordinator opens tenant review queue');
    assert.ok(queue.data.some(item => item.id === order.id),
      'unreviewed execution must be visible to coordinator');

    const verified = check(await request(reviewPath, {
      actor: coordinator, method: 'POST', body: review
    }), 200, 'different active actor verifies work with private evidence').data;
    assert.equal(verified.review_status, 'verified');
    assert.equal(verified.reviewed_by, coordinator.user);
    check(await request(reviewPath, {
      actor: admin, method: 'POST', body: review
    }), 409, 'execution cannot be reviewed twice');
    const closed = check(await request('/work-orders/' + order.id + '/status', {
      actor: admin, method: 'PATCH', body: { status: 'completed' }
    }), 200, 'admin closes verified order').data;
    assert.equal(closed.status, 'completed');

    // The recipient's cookie must not turn into report read permission.
    check(await request('/reports/field/' + field.id + '/export.csv', {
      actor: contractor
    }), 403, 'contractor cannot export private report');
    check(await request('/reports/field/' + field.id + '/export.pdf', {
      actor: outsider
    }), 404, 'foreign company cannot export report');
    for (const format of ['csv', 'pdf', 'xlsx']) {
      const output = check(await request(
        '/reports/field/' + field.id + '/export.' + format, {
          actor: coordinator
        }), 200, 'verified ' + format + ' field report').data;
      assert.deepEqual(output.counts, { observations: 1, workOrders: 1 },
        'same field must have exactly one observation and one verified order');
      assert.match(output.filename, new RegExp('\\.' + format + '

    // The same issued cookie is invalid after the admin blocks the scout;
    // a cached JWT or draft ID must not reauthorize another API request.
    check(await request('/auth/members/' + scout.membership + '/status', {
      actor: admin, method: 'PATCH', body: { status: 'blocked' }
    }), 200, 'block scout');
    check(await request('/auth/me', { actor: scout }),
      401, 'revoked scout login cookie');
    check(await request('/scouting/runs/' + run.id, { actor: scout }),
      401, 'revoked scout has no assigned run API');
    check(await request('/auth/members/' + contractor.membership + '/status', {
      actor: admin, method: 'PATCH', body: { status: 'blocked' }
    }), 200, 'block assigned contractor after review');
    check(await request('/auth/me', { actor: contractor }),
      401, 'revoked contractor cookie cannot restore session');
    check(await request('/work-orders/' + order.id, { actor: contractor }),
      401, 'revoked contractor cannot read former assignment');

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

    // The same real farm/field/campaign links every actor's records. Receipt
    // replay did NOT double-write an observation, order or either JPEG.
    const actual = (await owner.query(
      `SELECT
        (SELECT count(*)::int FROM scouting_observations WHERE id=$1) AS observations,
        (SELECT count(*)::int FROM work_orders WHERE id=$2) AS orders,
        (SELECT count(*)::int FROM work_order_executions WHERE id=$3) AS executions,
        (SELECT count(*)::int FROM evidence_assets WHERE id IN ($4,$5)) AS photos,
        (SELECT review_status FROM work_order_executions WHERE id=$3) AS review_status,
        (SELECT reviewed_by FROM work_order_executions WHERE id=$3) AS reviewer,
        (SELECT status FROM work_orders WHERE id=$2) AS order_status`,
      [observationId, order.id, execution.id,
        privateObservation.id, executionEvidence.id]
    )).rows[0];
    assert.deepEqual([
      actual.observations, actual.orders, actual.executions, actual.photos,
      actual.review_status, actual.reviewer, actual.order_status
    ], [1, 1, 1, 2, 'verified', coordinator.user, 'completed']);
    const geometry = (await owner.query(
      'SELECT ST_X(point) AS lon,ST_Y(point) AS lat FROM scouting_observations WHERE id=$1',
      [observationId]
    )).rows[0];
    assert.equal(geometry.lon, gps.coordinates[0]);
    assert.equal(geometry.lat, gps.coordinates[1]);
    const orderChain = (await owner.query(
      'SELECT o.tenant_id,o.field_id,o.campaign_field_id, ' +
      'e.submitted_by,e.reviewed_by, ' +
      'a.work_order_execution_id ' +
      'FROM work_orders o JOIN work_order_executions e ON e.work_order_id=o.id ' +
      'JOIN evidence_assets a ON a.work_order_execution_id=e.id ' +
      'WHERE o.id=$1 AND e.id=$2 AND a.id=$3',
      [order.id, execution.id, executionEvidence.id]
    )).rows;
    assert.equal(orderChain.length, 1);
    assert.equal(orderChain[0].tenant_id, admin.tenant);
    assert.equal(orderChain[0].field_id, field.id);
    assert.equal(orderChain[0].campaign_field_id, campaignField.id);
    assert.equal(orderChain[0].submitted_by, contractor.user);
    assert.equal(orderChain[0].reviewed_by, coordinator.user);
    assert.equal(orderChain[0].work_order_execution_id, execution.id);

    // Real non-owner PostGIS client cannot access another tenant even
    // when a leaked UUID has the correct shape.
    for (const [tenantId, expected] of [[admin.tenant, 1], [outsider.tenant, 0]]) {
      await runtime.query('BEGIN');
      try {
        await runtime.query("SELECT set_config('app.current_tenant',$1,true)", [tenantId]);
        const sql = await runtime.query(
          `SELECT
            (SELECT count(*)::int FROM scouting_runs WHERE id=$1) AS runs,
            (SELECT count(*)::int FROM scouting_observations WHERE id=$2) AS observations,
            (SELECT count(*)::int FROM work_orders WHERE id=$3) AS orders,
            (SELECT count(*)::int FROM work_order_executions WHERE id=$4) AS executions,
            (SELECT count(*)::int FROM evidence_assets WHERE id IN ($5,$6)) AS photos`,
          [run.id, observationId, order.id, execution.id,
            privateObservation.id, executionEvidence.id]
        );
        assert.deepEqual(Object.values(sql.rows[0]),
          [expected, expected, expected, expected, expected * 2]);
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
));
      if (format === 'csv') {
        assert.ok(output.csv.includes('HTTP integrated first field scouting concern'));
        assert.ok(output.csv.includes('Inspeccionar incidencia GPS'));
      } else {
        const bytes = Buffer.from(output.content_base64, 'base64');
        assert.equal(bytes.length, output.size_bytes);
        assert.deepEqual([...bytes.subarray(0, 4)],
          format === 'pdf' ? [37, 80, 68, 70] : [80, 75, 3, 4]);
      }
    }


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
