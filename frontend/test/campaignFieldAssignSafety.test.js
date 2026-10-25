import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  campaignFieldAssignScope, prepareCampaignFieldAssignment,
  verifyAssignedCampaignField, createCampaignFieldAssignGate
} from '../src/services/campaignFieldAssignSafety.js';

const tenant = '9d941d8a-9a66-4c6d-8469-54c37596e3a9';
const actor = '7d51278a-7a9b-4f02-817c-1b2079a6d748';
const campaign = '4b73e9e8-9375-41db-a574-7bbb38381704';
const field = 'b5f05b5f-1132-4342-b385-c004443f2cd9';
const crop = 'f43a2fad-dd0d-4ae5-a3d2-8b7bf57df639';
const variety = '66bf812c-c3a9-491a-af6b-8d55ed525d6d';
const other = 'b2774253-4071-4a68-9ec4-e9507a6ebd1e';
const assignedId = '54a3dfe2-eb54-4488-9497-1bd51894386e';
const session = { authenticated: true, tenant: { id: tenant }, user: { id: actor },
  membership: { id: other, roleCode: 'agronomic_coordinator' },
  entitlements: ['campaigns', 'gis'] };
const fields = [{ id: field, tenant_id: tenant, name: 'Lote Sur' }];
const crops = [{ id: crop, CropVarieties: [{ id: variety, name: 'Variedad 1' }] }];
const form = { field_id: field, crop_type_id: crop, crop_variety_id: variety,
  planting_date: '2026-09-01', harvest_target_date: '2027-03-15',
  expected_yield: '38.25', status: 'planned' };
const request = { ...form, expected_yield: 38.25 };
const receipt = { data: { id: assignedId, tenant_id: tenant, campaign_id: campaign,
  ...request, expected_yield: '38.25' } };

test('scope binds live tenant actor membership role entitlement and parent campaign', () => {
  const scope = campaignFieldAssignScope(session, 'live', campaign);
  assert.ok(scope);
  assert.equal(campaignFieldAssignScope({ ...session,
    entitlements: ['gis', 'campaigns', 'gis'] }, 'live', campaign), scope);
  for (const changed of [
    { tenant: { id: other } }, { user: { id: other } },
    { membership: { id: field, roleCode: 'agronomic_coordinator' } },
    { membership: { id: other, roleCode: 'tenant_admin' } },
    { entitlements: ['campaigns'] }
  ]) assert.notEqual(campaignFieldAssignScope({ ...session, ...changed }, 'live', campaign), scope);
  for (const changed of [
    { authenticated: false }, { tenant: {} }, { user: {} },
    { membership: { roleCode: 'scout' } }, { membership: null },
    { entitlements: ['scouting'] }, { entitlements: null }
  ]) assert.equal(campaignFieldAssignScope({ ...session, ...changed }, 'live', campaign), null);
  assert.equal(campaignFieldAssignScope(session, 'mock', campaign), null);
  assert.equal(campaignFieldAssignScope(session, 'live', 'wrong'), null);
  assert.notEqual(campaignFieldAssignScope(session, 'live', other), scope);
});

test('valid body preserves crop/variety and numeric decimal; empty optional values omitted', () => {
  assert.deepEqual(prepareCampaignFieldAssignment(form, fields, crops, tenant), request);
  const optional = prepareCampaignFieldAssignment({
    ...form, crop_variety_id: '', planting_date: '',
    harvest_target_date: '', expected_yield: ''
  }, fields, crops, tenant);
  assert.deepEqual(optional, { field_id: field, crop_type_id: crop, status: 'planned' });
  assert.equal(prepareCampaignFieldAssignment({
    ...form, expected_yield: '0'
  }, fields, crops, tenant).expected_yield, 0);
});

test('fail closed on wrong crop, wrong tenant, unknown varieties or catalogs', () => {
  const invalid = [
    { form: { ...form, field_id: other } },
    { form: { ...form, crop_type_id: other } },
    { form: { ...form, crop_variety_id: other } },
    { fieldList: [{ ...fields[0], tenant_id: other }] },
    { fieldList: null }, { cropList: null },
    { cropList: [{ id: crop, CropVarieties: null }] },
    { tenantId: 'wrong' }
  ];
  for (const changed of invalid) assert.throws(() => prepareCampaignFieldAssignment(
    changed.form || form, changed.fieldList === undefined ? fields : changed.fieldList,
    changed.cropList === undefined ? crops : changed.cropList,
    changed.tenantId === undefined ? tenant : changed.tenantId
  ), /empresa|lote|cultivo|variedad|catálogo|no se pudieron/i);
});

test('reject impossible dates, backwards harvest, negative or overprecise yield', () => {
  for (const modified of [
    { planting_date: '2027-02-29' }, { planting_date: '2026-02-30' },
    { harvest_target_date: '2026-13-01' },
    { harvest_target_date: '2026-08-31' },
    { expected_yield: '-1' }, { expected_yield: '1.234' },
    { expected_yield: '1e7' }, { expected_yield: 'NaN' },
    { expected_yield: '10000000000.00' }, { status: 'closed' }
  ]) assert.throws(() => prepareCampaignFieldAssignment(
    { ...form, ...modified }, fields, crops, tenant
  ), /fecha|cosecha|rendimiento|estado/i);
  assert.doesNotThrow(() => prepareCampaignFieldAssignment({
    ...form, planting_date: '2028-02-29', harvest_target_date: '2028-02-29'
  }, fields, crops, tenant));
});

test('server ACK must refer to original campaign/tenant/crop/field/dates/decimal', () => {
  assert.equal(verifyAssignedCampaignField(receipt, request, tenant, campaign), receipt.data);
  const edits = [
    { id: 'invalid' }, { tenant_id: other }, { campaign_id: other },
    { field_id: other }, { crop_type_id: other }, { crop_variety_id: other },
    { planting_date: '2026-09-02' }, { harvest_target_date: null },
    { expected_yield: '39.00' }, { status: 'harvested' }
  ];
  for (const edit of edits) assert.throws(() => verifyAssignedCampaignField(
    { data: { ...receipt.data, ...edit } }, request, tenant, campaign
  ), /no confirmó/i);
  for (const invalid of [null, {}, { data: [] }, { data: {} }]) assert.throws(
    () => verifyAssignedCampaignField(invalid, request, tenant, campaign), /no confirmó/i);
});

test('ACK optional nulls and exact zero yield are accepted, unexpected fields rejected', () => {
  const body = { field_id: field, crop_type_id: crop, status: 'active' };
  const row = { id: assignedId, tenant_id: tenant, campaign_id: campaign,
    ...body, crop_variety_id: null, planting_date: null, harvest_target_date: null,
    expected_yield: null };
  assert.equal(verifyAssignedCampaignField({ data: row }, body, tenant, campaign), row);
  assert.throws(() => verifyAssignedCampaignField({
    data: { ...row, crop_variety_id: variety }
  }, body, tenant, campaign), /no confirmó/i);
  const zero = { ...body, expected_yield: 0 };
  assert.equal(verifyAssignedCampaignField({ data: { ...row, expected_yield: '0.00' } },
    zero, tenant, campaign).id, assignedId);
});

test('ticket blocks synchronous double submit and ambiguous POST outcome', async () => {
  const gate = createCampaignFieldAssignGate();
  const scope = campaignFieldAssignScope(session, 'live', campaign);
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let posts = 0;
  const submit = async () => {
    const ticket = gate.acquire(scope);
    if (!ticket) return 'blocked';
    posts++;
    await pending;
    verifyAssignedCampaignField(receipt, request, tenant, campaign);
    gate.finish(ticket, 'confirmed');
    return 'confirmed';
  };
  const first = submit();
  assert.equal(await submit(), 'blocked');
  assert.equal(posts, 1);
  release();
  assert.equal(await first, 'confirmed');
  assert.equal(await submit(), 'blocked');
  gate.reset();
  const uncertain = gate.acquire(scope);
  assert.ok(uncertain);
  assert.equal(gate.finish(uncertain, 'uncertain'), true);
  assert.equal(gate.acquire(scope), null);
});

test('old ticket cannot complete under changed actor or campaign', () => {
  const gate = createCampaignFieldAssignGate();
  const scope = campaignFieldAssignScope(session, 'live', campaign);
  const old = gate.acquire(scope);
  gate.reset();
  const second = gate.acquire(campaignFieldAssignScope(session, 'live', other));
  assert.equal(gate.finish(old, 'confirmed'), false);
  assert.equal(gate.isPending(second.scope), true);
  assert.equal(gate.finish(second, 'confirmed'), true);
});

test('component uses real catalogs only, fences stale replies and disables mock success', () => {
  const source = readFileSync(new URL('../src/components/AssignFieldModal.jsx', import.meta.url), 'utf8');
  assert.match(source, /campaignFieldAssignScope\(session, dataMode, campaignId\)/);
  assert.match(source, /submitGate\.current\.acquire\(authority\)/);
  assert.match(source, /prepareCampaignFieldAssignment\(form, fields, cropTypes, session\?\.tenant\?\.id\)/);
  assert.match(source, /verifyAssignedCampaignField\(response, body, session\?\.tenant\?\.id, campaignId\)/);
  assert.match(source, /scopeRef\.current === requestScope/);
  assert.match(source, /onClose=\{safeClose\}/);
  assert.doesNotMatch(source, /setFields\(mockData\.fields\)|setCropTypes\(mockData\.cropTypes\)/);
  assert.doesNotMatch(source, /dataMode === 'mock'\) \{ onCreated/);
});
