import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  campaignFieldAssignScope, createCampaignFieldAssignGate, verifyAssignedCampaignField
} from '../src/services/campaignFieldAssignSafety.js';
import {
  readCampaignFieldAssignRecovery, saveCampaignFieldAssignRecovery,
  discardCampaignFieldAssignRecovery
} from '../src/services/campaignFieldAssignRecoveryStore.js';

const source = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const tenant = '9d941d8a-9a66-4c6d-8469-54c37596e3a9';
const actor = '7d51278a-7a9b-4f02-817c-1b2079a6d748';
const campaign = '4b73e9e8-9375-41db-a574-7bbb38381704';
const field = 'b5f05b5f-1132-4342-b385-c004443f2cd9';
const crop = 'f43a2fad-dd0d-4ae5-a3d2-8b7bf57df639';
const id = '54a3dfe2-eb54-4488-9497-1bd51894386e';
const session = { authenticated: true, tenant: { id: tenant }, user: { id: actor },
  membership: { id: id, roleCode: 'tenant_admin' }, entitlements: ['campaigns'] };
const payload = Object.freeze({
  client_request_id: randomUUID(), field_id: field, crop_type_id: crop,
  status: 'planned', expected_yield: 28.5
});

test('recovery store is independently encrypted, scoped and never keeps credentials', () => {
  const wrapper = source('../src/services/campaignFieldAssignRecoveryStore.js');
  const store = source('../src/services/encryptedCreateJournal.js');
  const modal = source('../src/components/AssignFieldModal.jsx');
  assert.match(wrapper, /databaseName: 'sedeagro-campaign-field-assign-recovery'/);
  assert.match(wrapper, /aadDomain: 'sedeagro:campaign-field-assign-recovery:v1:'/);
  assert.doesNotMatch(wrapper, /localStorage|sessionStorage|Authorization|Bearer/);
  assert.match(store, /AES-GCM/);
  assert.match(store, /false, \['encrypt', 'decrypt'\]/);
  assert.match(store, /tx\.objectStore\(PENDING\)\.add\(/);
  assert.match(store, /additionalData: additionalData\(scope, body.client_request_id\)/);
  assert.match(modal, /await saveCampaignFieldAssignRecovery\(authority, body\)/);
  assert.match(modal, /void sendAssign\(ticket, body, api\)/);
  assert.ok(modal.indexOf('await saveCampaignFieldAssignRecovery(authority, body)') <
    modal.indexOf('void sendAssign(ticket, body, api)'));
  assert.match(modal, /readCampaignFieldAssignRecovery\(authority\)/);
  assert.match(modal, /await discardCampaignFieldAssignRecovery\(authority, body.client_request_id\)/);
  assert.match(modal, /submitGate\.current\.isPending\(authority\)/);
});

test('journal rejects missing identity or storage rather than silently allowing POST', async () => {
  const scope = campaignFieldAssignScope(session, 'live', campaign);
  assert.ok(scope);
  await assert.rejects(saveCampaignFieldAssignRecovery(scope,
    { ...payload, field_id: 'invalid' }), /identidad recuperable/i);
  await assert.rejects(saveCampaignFieldAssignRecovery(scope,
    { ...payload, client_request_id: 'invalid' }), /identidad recuperable/i);
  assert.equal(await readCampaignFieldAssignRecovery(null), null);
  assert.equal(await discardCampaignFieldAssignRecovery(null, payload.client_request_id), false);
  assert.equal(await discardCampaignFieldAssignRecovery(scope, 'invalid'), false);
});

test('ticket requires explicit retry after uncertain ACK, with double-click protection', () => {
  const scope = campaignFieldAssignScope(session, 'live', campaign);
  const gate = createCampaignFieldAssignGate();
  const original = gate.acquire(scope);
  assert.ok(original);
  assert.equal(gate.acquire(scope), null);
  assert.equal(gate.retry(scope), null, 'cannot replay while a POST is running');
  assert.equal(gate.finish(original, 'uncertain'), true);
  const retry = gate.retry(scope);
  assert.ok(retry);
  assert.notEqual(retry.id, original.id);
  assert.equal(gate.retry(scope), null);
  assert.equal(gate.finish(original, 'confirmed'), false, 'late prior ACK is fenced');
  assert.equal(gate.finish(retry, 'confirmed'), true);
  assert.equal(gate.acquire(scope), null);
  const different = campaignFieldAssignScope({ ...session, user: { id: id } }, 'live', campaign);
  gate.reset();
  const newTicket = gate.acquire(different);
  assert.ok(newTicket);
  assert.equal(gate.finish(original, 'uncertain'), false);
  assert.equal(gate.retry(scope), null);
});

test('original request ACK is never confused with another tenant, campaign or field', () => {
  const original = { ...payload };
  const receipt = { data: {
    id, tenant_id: tenant, campaign_id: campaign,
    field_id: field, crop_type_id: crop, crop_variety_id: null,
    planting_date: null, harvest_target_date: null,
    expected_yield: '28.50', status: 'planned'
  }, replayed: true };
  assert.equal(verifyAssignedCampaignField(receipt, original, tenant, campaign).id, id);
  for (const bad of [
    { tenant_id: actor }, { campaign_id: actor }, { field_id: actor },
    { expected_yield: 29 }, { crop_type_id: actor }
  ]) assert.throws(() => verifyAssignedCampaignField({
    ...receipt, data: { ...receipt.data, ...bad }
  }, original, tenant, campaign), /no confirmó/i);
});

test('reopen restores exact request but does not POST until explicit operator click', () => {
  const modal = source('../src/components/AssignFieldModal.jsx');
  const restoration = modal.slice(modal.indexOf('void readCampaignFieldAssignRecovery(authority)'),
    modal.indexOf('  }, [isOpen, authority, api]);'));
  assert.match(restoration, /setSubmitStatus\('uncertain'\)/);
  assert.doesNotMatch(restoration, /sendAssign\(/);
  assert.match(modal, /handleRetry/);
  assert.match(modal, /Reintentar el mismo envío/);
  assert.match(modal, /handleDiscard/);
  assert.match(modal, /Descartar tras revisar la campaña/);
  assert.match(modal, /recoveryLoading \|\| recoveryBlocked/);
  assert.match(modal, /scopeRef\.current !== authority/);
  assert.match(modal, /apiRef\.current !== api/);
  assert.match(modal, /requestRef\.current\?\.body === body/);
  assert.doesNotMatch(modal, /localStorage|sessionStorage/);
});
