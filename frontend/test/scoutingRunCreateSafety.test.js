import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  scoutingRunCreateScope, verifyCreatedScoutingRun, createScoutingRunSubmitGate
} from '../src/services/scoutingRunCreateSafety.js';

const tenant = '9d941d8a-9a66-4c6d-8469-54c37596e3a9';
const otherTenant = 'b2774253-4071-4a68-9ec4-e9507a6ebd1e';
const actor = '7d51278a-7a9b-4f02-817c-1b2079a6d748';
const member = '96df2c65-ae43-4dbf-9080-42bf218d6d49';
const field = 'b5f05b5f-1132-4342-b385-c004443f2cd9';
const assignee = '1e9d9ca6-6aa6-4710-af48-1a7905529450';
const runId = '4b73e9e8-9375-41db-a574-7bbb38381704';
const session = { authenticated: true, tenant: { id: tenant }, user: { id: actor },
  membership: { id: member, roleCode: 'agronomic_coordinator' },
  entitlements: ['scouting', 'campaigns', 'gis'] };
const request = { campaign_field_id: field, assigned_to: assignee,
  scheduled_at: '2026-10-30T12:30:00.000Z', status: 'in_progress', summary: 'Revisar malezas' };
const reply = { data: { id: runId, tenant_id: tenant, ...request } };

test('scope only for current authenticated live planners with scouting entitlement', () => {
  const scope = scoutingRunCreateScope(session, 'live');
  assert.ok(scope);
  assert.equal(scoutingRunCreateScope({ ...session,
    entitlements: ['gis', 'scouting', 'campaigns', 'scouting'] }, 'live'), scope);
  for (const edited of [
    { tenant: { id: otherTenant } },
    { user: { id: otherTenant } },
    { membership: { ...session.membership, id: otherTenant } },
    { membership: { ...session.membership, roleCode: 'tenant_admin' } },
    { entitlements: ['scouting'] }
  ]) assert.notEqual(scoutingRunCreateScope({ ...session, ...edited }, 'live'), scope);
  for (const invalid of [
    { authenticated: false }, { tenant: {} }, { user: {} },
    { membership: { roleCode: 'scout' } }, { membership: { roleCode: 'contractor' } },
    { entitlements: ['campaigns'] }, { entitlements: null }
  ]) assert.equal(scoutingRunCreateScope({ ...session, ...invalid }, 'live'), null);
  assert.equal(scoutingRunCreateScope(session, 'mock'), null);
  assert.equal(scoutingRunCreateScope(null, 'live'), null);
});

test('run receipt binds server row to tenant, field, assignee, status and scheduled time', () => {
  assert.equal(verifyCreatedScoutingRun(reply, request, tenant), reply.data);
  const equivalent = { data: { ...reply.data, scheduled_at: '2026-10-30T09:30:00-03:00' } };
  assert.equal(verifyCreatedScoutingRun(equivalent, request, tenant), equivalent.data);
  for (const changed of [
    { id: '' }, { id: 'forged' }, { tenant_id: otherTenant },
    { campaign_field_id: otherTenant }, { assigned_to: otherTenant },
    { status: 'planned' }, { scheduled_at: null },
    { scheduled_at: '2026-10-30T12:29:00.000Z' }, { summary: 'Otra recorrida' }
  ]) assert.throws(() => verifyCreatedScoutingRun(
    { data: { ...reply.data, ...changed } }, request, tenant), /no confirmó/i);
  for (const invalid of [null, {}, { data: {} }, { data: [] }, { data: null }]) {
    assert.throws(() => verifyCreatedScoutingRun(invalid, request, tenant), /no confirmó/i);
  }
  assert.throws(() => verifyCreatedScoutingRun(reply, request, otherTenant), /no confirmó/i);
  assert.throws(() => verifyCreatedScoutingRun(reply,
    { ...request, campaign_field_id: otherTenant }, tenant), /no confirmó/i);
  assert.throws(() => verifyCreatedScoutingRun(reply,
    { ...request, assigned_to: null }, tenant), /no confirmó/i);
});

test('optional assignment, schedule and summary require matching empty receipt', () => {
  const input = { campaign_field_id: field, assigned_to: null, status: 'planned' };
  const response = { data: { id: runId, tenant_id: tenant,
    campaign_field_id: field, assigned_to: null, scheduled_at: null,
    summary: null, status: 'planned' } };
  assert.equal(verifyCreatedScoutingRun(response, input, tenant), response.data);
  assert.throws(() => verifyCreatedScoutingRun(response,
    { ...input, assigned_to: assignee }, tenant), /no confirmó/i);
  assert.throws(() => verifyCreatedScoutingRun({ data: { ...response.data,
    scheduled_at: '2026-11-02T12:00:00.000Z' } }, input, tenant), /no confirmó/i);
  assert.throws(() => verifyCreatedScoutingRun({ data: { ...response.data,
    summary: 'Otro monitoreo' } }, input, tenant), /no confirmó/i);
});

test('double-tap gate remains blocked after confirmation and lost ACK', () => {
  const gate = createScoutingRunSubmitGate();
  const scope = scoutingRunCreateScope(session, 'live');
  const ticket = gate.acquire(scope);
  assert.ok(ticket);
  assert.equal(gate.acquire(scope), null);
  assert.equal(gate.isPending(scope), true);
  assert.equal(gate.finish(ticket, 'confirmed'), true);
  assert.equal(gate.isPending(scope), false);
  assert.equal(gate.isBlocked(scope), true);
  assert.equal(gate.acquire(scope), null);
  gate.reset();
  const uncertain = gate.acquire(scope);
  assert.equal(gate.finish(uncertain, 'uncertain'), true);
  assert.equal(gate.acquire(scope), null);
  assert.equal(gate.isBlocked(scope), true);
});

test('pre-dispatch rejection is retryable and stale completion cannot unlock next account', () => {
  const gate = createScoutingRunSubmitGate();
  const scope = scoutingRunCreateScope(session, 'live');
  const original = gate.acquire(scope);
  assert.equal(gate.finish(original, 'preflight-rejected'), true);
  assert.ok(gate.acquire(scope));
  gate.reset();
  const nextScope = scoutingRunCreateScope({ ...session,
    tenant: { id: otherTenant } }, 'live');
  const latest = gate.acquire(nextScope);
  assert.equal(gate.finish(original, 'uncertain'), false);
  assert.equal(gate.isPending(nextScope), true);
  assert.equal(gate.finish(latest, 'confirmed'), true);
  assert.equal(gate.isBlocked(nextScope), true);
});

test('simultaneous async submissions start only one POST even before React rerender', async () => {
  const gate = createScoutingRunSubmitGate();
  const scope = scoutingRunCreateScope(session, 'live');
  let release;
  const remote = new Promise(resolve => { release = resolve; });
  let posts = 0;
  async function submit() {
    const ticket = gate.acquire(scope);
    if (!ticket) return 'blocked';
    posts += 1;
    try {
      await remote;
      verifyCreatedScoutingRun(reply, request, tenant);
      gate.finish(ticket, 'confirmed');
      return 'confirmed';
    } catch {
      gate.finish(ticket, 'uncertain');
      return 'uncertain';
    }
  }
  const first = submit();
  assert.equal(await submit(), 'blocked');
  assert.equal(posts, 1);
  release();
  assert.equal(await first, 'confirmed');
  assert.equal(await submit(), 'blocked');
  assert.equal(posts, 1);
});

test('modal wires render-time scope fence and safe close around POST', () => {
  const jsx = readFileSync(new URL('../src/components/ScoutingRunFormModal.jsx', import.meta.url), 'utf8');
  assert.match(jsx, /scoutingRunCreateScope\(session, dataMode\)/);
  assert.match(jsx, /submitGate\.current\.acquire\(authority\)/);
  assert.match(jsx, /verifyCreatedScoutingRun\(response, body, session\?\.tenant\?\.id\)/);
  assert.match(jsx, /submitGate\.current\.isPending\(authority\)/);
  assert.match(jsx, /optionsSnapshot\?\.scope === authority/);
  assert.match(jsx, /optionsSnapshot\?\.api === api/);
  assert.match(jsx, /scopeRef\.current === authority/);
  assert.match(jsx, /onClose=\{safeClose\}/);
  assert.doesNotMatch(jsx, /await api\.createScoutingRun\([\s\S]*?\);\s*onCreated\?\.\(\)/);
});


test('idempotent create ACK requires explicit replay outcome when client_request_id was sent', () => {
  const keyed = { ...request, client_request_id: otherTenant };
  assert.equal(verifyCreatedScoutingRun({ ...reply, replayed: false }, keyed, tenant), reply.data);
  assert.equal(verifyCreatedScoutingRun({ ...reply, replayed: true }, keyed, tenant), reply.data);
  for (const bad of [undefined, null, 'true', 0]) {
    assert.throws(() => verifyCreatedScoutingRun({ ...reply, replayed: bad }, keyed, tenant),
      /no confirmó/i);
  }
  // Backward-compatible helper use for historical callers without client UUID.
  assert.equal(verifyCreatedScoutingRun(reply, request, tenant), reply.data);
});

test('explicit retry of uncertain ticket serializes exactly one second dispatch', () => {
  const scope = scoutingRunCreateScope(session, 'live');
  const gate = createScoutingRunSubmitGate();
  assert.equal(gate.retry(scope), null);
  const initial = gate.acquire(scope);
  assert.ok(initial);
  assert.equal(gate.retry(scope), null, 'pending request can never be retried');
  assert.equal(gate.finish(initial, 'uncertain'), true);
  assert.equal(gate.acquire(scope), null, 'normal create stays sticky');
  const retry = gate.retry(scope);
  assert.ok(retry);
  assert.notEqual(retry, initial);
  assert.equal(gate.isPending(scope), true);
  assert.equal(gate.retry(scope), null, 'rapid double retry may not dispatch twice');
  assert.equal(gate.finish(initial, 'confirmed'), false, 'stale original ACK cannot complete a retry');
  assert.equal(gate.finish(retry, 'confirmed'), true);
  assert.equal(gate.retry(scope), null, 'confirmed request cannot retry');
  assert.equal(gate.isBlocked(scope), true);
  gate.reset();
  assert.equal(gate.finish(retry, 'uncertain'), false);
  assert.equal(gate.retry(scope), null);
});

test('retry binds unchanged UUID and body, and does not silently recreate a run', async () => {
  const scope = scoutingRunCreateScope(session, 'live');
  const gate = createScoutingRunSubmitGate();
  const body = Object.freeze({ ...request, client_request_id: otherTenant });
  const sent = [];
  async function send(ticket, fail) {
    sent.push(body);
    if (fail) {
      gate.finish(ticket, 'uncertain');
      return 'uncertain';
    }
    verifyCreatedScoutingRun({ ...reply, replayed: true }, body, tenant);
    gate.finish(ticket, 'confirmed');
    return 'confirmed';
  }
  const first = gate.acquire(scope);
  assert.equal(await send(first, true), 'uncertain');
  const same = gate.retry(scope);
  assert.equal(await send(same, false), 'confirmed');
  assert.equal(sent.length, 2);
  assert.equal(sent[0], sent[1]);
  assert.equal(sent[0].client_request_id, otherTenant);
});

test('scouting modal wires browser UUID only once and uses saved request on explicit retry', () => {
  const jsx = readFileSync(new URL('../src/components/ScoutingRunFormModal.jsx', import.meta.url), 'utf8');
  assert.match(jsx, /crypto\.randomUUID\(\)/);
  assert.match(jsx, /client_request_id:/);
  assert.match(jsx, /requestRef\.current =/);
  assert.match(jsx, /submitGate\.current\.retry\(authority\)/);
  assert.match(jsx, /sendCreate\(ticket, saved\.body, saved\.api\)/);
  assert.match(jsx, /verifyCreatedScoutingRun\(response, body, session\?\.tenant\?\.id\)/);
  assert.doesNotMatch(jsx, /sessionStorage|localStorage/);
});
