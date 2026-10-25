import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  campaignCreateScope, prepareCampaignCreate, verifyCreatedCampaign, createCampaignSubmitGate
} from '../src/services/campaignCreateSafety.js';

const tenant = '9d941d8a-9a66-4c6d-8469-54c37596e3a9';
const actor = '7d51278a-7a9b-4f02-817c-1b2079a6d748';
const member = '96df2c65-ae43-4dbf-9080-42bf218d6d49';
const otherId = 'b2774253-4071-4a68-9ec4-e9507a6ebd1e';
const campaignId = '4b73e9e8-9375-41db-a574-7bbb38381704';
const session = { authenticated: true, tenant: { id: tenant }, user: { id: actor },
  membership: { id: member, roleCode: 'agronomic_coordinator' },
  entitlements: ['campaigns', 'gis'] };
const form = { name: ' Campaña fina 2026 ', season_year: '2026',
  starts_at: '2026-05-01', ends_at: '2026-12-15', status: 'planned' };
const request = { name: 'Campaña fina 2026', season_year: 2026,
  starts_at: '2026-05-01', ends_at: '2026-12-15', status: 'planned' };
const receipt = { data: { id: campaignId, tenant_id: tenant, ...request } };

test('scope is live and bound to tenant, actor, membership, planner role and entitlements', () => {
  const scope = campaignCreateScope(session, 'live');
  assert.ok(scope);
  assert.equal(campaignCreateScope({ ...session, entitlements: ['gis', 'campaigns', 'gis'] }, 'live'), scope);
  for (const altered of [
    { tenant: { id: otherId } }, { user: { id: otherId } },
    { membership: { id: otherId, roleCode: 'agronomic_coordinator' } },
    { membership: { id: member, roleCode: 'tenant_admin' } }, { entitlements: ['campaigns'] }
  ]) assert.notEqual(campaignCreateScope({ ...session, ...altered }, 'live'), scope);
  for (const altered of [
    { authenticated: false }, { tenant: {} }, { user: {} },
    { membership: { id: member, roleCode: 'scout' } },
    { membership: { id: member, roleCode: 'producer_viewer' } },
    { membership: { roleCode: 'tenant_admin' } },
    { entitlements: ['gis'] }, { entitlements: null }
  ]) assert.equal(campaignCreateScope({ ...session, ...altered }, 'live'), null);
  assert.equal(campaignCreateScope(session, 'mock'), null);
  assert.equal(campaignCreateScope(null, 'live'), null);
});

test('create body trims name, normalizes numeric season year and omits blank optional end', () => {
  assert.deepEqual(prepareCampaignCreate(form), request);
  assert.deepEqual(prepareCampaignCreate({ ...form, ends_at: '' }), {
    name: request.name, season_year: 2026, starts_at: request.starts_at, status: 'planned'
  });
  assert.deepEqual(prepareCampaignCreate({ ...form, name: '  Campaña estival  ', season_year: 2027,
    starts_at: '2027-09-01', ends_at: '2028-07-31', status: 'active' }), {
    name: 'Campaña estival', season_year: 2027, starts_at: '2027-09-01',
    ends_at: '2028-07-31', status: 'active'
  });
});

test('reject invalid calendar dates, backwards interval, and unsupported values before POST', () => {
  for (const modified of [
    { starts_at: '2026-02-30' }, { starts_at: '2026-13-01' },
    { starts_at: '2026-2-01' }, { starts_at: '' },
    { ends_at: '2026-04-30' }, { ends_at: '2026-12-32' },
    { season_year: '2026.2' }, { season_year: 'not-a-year' },
    { season_year: '1999' }, { season_year: '2101' },
    { status: 'archived' }, { name: 'x' }, { name: '  ' }, { name: 'x'.repeat(161) }
  ]) assert.throws(() => prepareCampaignCreate({ ...form, ...modified }), /campaña|fecha|año|estado|nombre|inicio|fin/i);
  assert.doesNotThrow(() => prepareCampaignCreate({ ...form,
    starts_at: '2028-02-29', ends_at: '2028-02-29' }));
  assert.throws(() => prepareCampaignCreate({ ...form,
    starts_at: '2027-02-29', ends_at: '' }), /fecha/i);
});

test('server ACK requires original tenant, UUID, exact name, year, interval and status', () => {
  assert.equal(verifyCreatedCampaign(receipt, request, tenant), receipt.data);
  for (const modified of [
    { id: '' }, { id: 'wrong' }, { tenant_id: otherId }, { name: 'Campaña gruesa' },
    { season_year: 2025 }, { starts_at: '2026-05-02' }, { ends_at: '2026-12-16' },
    { status: 'active' }
  ]) assert.throws(() => verifyCreatedCampaign({ data: { ...receipt.data, ...modified } }, request, tenant),
    /no confirmó/i);
  for (const invalid of [null, {}, { data: null }, { data: [] }, { data: {} }])
    assert.throws(() => verifyCreatedCampaign(invalid, request, tenant), /no confirmó/i);
  assert.throws(() => verifyCreatedCampaign(receipt, request, otherId), /no confirmó/i);
});

test('optional end must be absent/null in response if not requested', () => {
  const noEnd = { ...request };
  delete noEnd.ends_at;
  const reply = { data: { ...receipt.data, ends_at: null } };
  assert.equal(verifyCreatedCampaign(reply, noEnd, tenant), reply.data);
  assert.throws(() => verifyCreatedCampaign(receipt, noEnd, tenant), /no confirmó/i);
});

test('two synchronous submits in same opening dispatch exactly one POST', async () => {
  const gate = createCampaignSubmitGate();
  const scope = campaignCreateScope(session, 'live');
  let unblock;
  const remote = new Promise(resolve => { unblock = resolve; });
  let posts = 0;
  const submit = async () => {
    const ticket = gate.acquire(scope);
    if (!ticket) return 'blocked';
    posts++;
    await remote;
    verifyCreatedCampaign(receipt, request, tenant);
    gate.finish(ticket, 'confirmed');
    return 'confirmed';
  };
  const first = submit();
  assert.equal(await submit(), 'blocked');
  assert.equal(posts, 1);
  unblock();
  assert.equal(await first, 'confirmed');
  assert.equal(await submit(), 'blocked');
  assert.equal(gate.isPending(scope), false);
  assert.equal(gate.isBlocked(scope), true);
});

test('uncertain ACK remains blocked; pre-dispatch failure is retryable; stale tickets do not unlock new scope', () => {
  const gate = createCampaignSubmitGate();
  const scope = campaignCreateScope(session, 'live');
  const first = gate.acquire(scope);
  assert.equal(gate.isPending(scope), true);
  assert.equal(gate.finish(first, 'uncertain'), true);
  assert.equal(gate.acquire(scope), null);
  gate.reset();
  const retry = gate.acquire(scope);
  assert.equal(gate.finish(retry, 'preflight-rejected'), true);
  assert.ok(gate.acquire(scope));
  gate.reset();
  const nextScope = campaignCreateScope({ ...session, tenant: { id: otherId } }, 'live');
  const next = gate.acquire(nextScope);
  assert.equal(gate.finish(first, 'confirmed'), false);
  assert.equal(gate.isPending(nextScope), true);
  assert.equal(gate.finish(next, 'confirmed'), true);
  assert.equal(gate.acquire(nextScope), null);
});

test('modal uses synchronous safety ticket and session fencing before success callback', () => {
  const jsx = readFileSync(new URL('../src/components/CampaignFormModal.jsx', import.meta.url), 'utf8');
  assert.match(jsx, /campaignCreateScope\(session, dataMode\)/);
  assert.match(jsx, /submitGate\.current\.acquire\(authority\)/);
  assert.match(jsx, /prepareCampaignCreate\(form\)/);
  assert.match(jsx, /verifyCreatedCampaign\(response, body, session\?\.tenant\?\.id\)/);
  assert.match(jsx, /scopeRef\.current === authority/);
  assert.match(jsx, /submitGate\.current\.isPending\(authority\)/);
  assert.match(jsx, /onClose=\{safeClose\}/);
  assert.doesNotMatch(jsx, /dataMode === 'mock'\) \{ onCreated/);
});


test('keyed campaign ACK requires explicit boolean replay outcome', () => {
  const keyed = { ...request, client_request_id: otherId };
  const created = { ...receipt, replayed: false };
  assert.equal(verifyCreatedCampaign(created, keyed, tenant), created.data);
  const replay = { ...receipt, replayed: true };
  assert.equal(verifyCreatedCampaign(replay, keyed, tenant), replay.data);
  for (const value of [undefined, null, 'false', 0]) {
    assert.throws(() => verifyCreatedCampaign({ ...receipt, replayed: value }, keyed, tenant),
      /no confirmó/i);
  }
  assert.equal(verifyCreatedCampaign(receipt, request, tenant), receipt.data,
    'legacy caller has no replay flag requirement');
});

test('uncertain keyed attempt allows only explicit same-scope retry, one at a time', () => {
  const gate = createCampaignSubmitGate();
  const scope = campaignCreateScope(session, 'live');
  assert.equal(gate.retry(scope), null);
  const original = gate.acquire(scope);
  assert.ok(original);
  assert.equal(gate.retry(scope), null, 'cannot retry while request pending');
  assert.equal(gate.finish(original, 'uncertain'), true);
  assert.equal(gate.acquire(scope), null, 'new payload is never sent after uncertain ACK');
  assert.equal(gate.retry('another-scope'), null);
  const attempt = gate.retry(scope);
  assert.ok(attempt);
  assert.equal(gate.retry(scope), null, 'double tap is synchronous');
  assert.equal(gate.finish(original, 'confirmed'), false, 'stale first ACK never confirms retry');
  assert.equal(gate.finish(attempt, 'uncertain'), true);
  const again = gate.retry(scope);
  assert.ok(again);
  assert.equal(gate.finish(again, 'confirmed'), true);
  assert.equal(gate.retry(scope), null, 'confirmed payload must not repeat');
  gate.reset();
  assert.equal(gate.finish(again, 'uncertain'), false);
});

test('manual retry sends exact same frozen campaign UUID and body', async () => {
  const gate = createCampaignSubmitGate();
  const scope = campaignCreateScope(session, 'live');
  const body = Object.freeze({ ...request, client_request_id: otherId });
  const dispatched = [];
  async function dispatch(ticket, shouldFail) {
    dispatched.push(body);
    if (shouldFail) {
      gate.finish(ticket, 'uncertain');
      return 'uncertain';
    }
    verifyCreatedCampaign({ ...receipt, replayed: true }, body, tenant);
    gate.finish(ticket, 'confirmed');
    return 'confirmed';
  }
  const first = gate.acquire(scope);
  assert.equal(await dispatch(first, true), 'uncertain');
  assert.equal(await dispatch(gate.retry(scope), false), 'confirmed');
  assert.equal(dispatched.length, 2);
  assert.equal(dispatched[0], dispatched[1]);
  assert.equal(dispatched[0].client_request_id, otherId);
});

test('campaign creation UI generates key once, retains immutable body and exposes intentional retry', () => {
  const jsx = readFileSync(new URL('../src/components/CampaignFormModal.jsx', import.meta.url), 'utf8');
  assert.match(jsx, /crypto\.randomUUID\(\)/);
  assert.match(jsx, /client_request_id:/);
  assert.match(jsx, /requestRef\.current =/);
  assert.match(jsx, /submitGate\.current\.retry\(authority\)/);
  assert.match(jsx, /sendCreate\(ticket, saved\.body, saved\.api\)/);
  assert.match(jsx, /verifyCreatedCampaign\(response, body, session\?\.tenant\?\.id\)/);
  assert.doesNotMatch(jsx, /localStorage|sessionStorage/);
  assert.match(jsx, /submitGate\.current\.isPending\(authority\)/);
});
