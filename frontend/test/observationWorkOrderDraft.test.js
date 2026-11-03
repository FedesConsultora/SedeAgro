import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  observationWorkOrderDraft, workOrderFormFromObservationDraft
} from '../src/services/observationWorkOrderDraft.js';

const tenant = '9d941d8a-9a66-4c6d-8469-54c37596e3a9';
const actor = '7d51278a-7a9b-4f02-817c-1b2079a6d748';
const runId = 'ce2405b5-2d3e-48b0-905f-b294e90df64f';
const observationId = 'b6a4534c-6e82-4f4e-b0a2-35b6d4f9317d';
const campaignFieldId = 'de16b90c-4b72-4490-9f5f-b20fe3c804be';
const fieldId = 'b5f05b5f-1132-4342-b385-c004443f2cd9';
const session = { authenticated: true, tenant: { id: tenant }, user: { id: actor },
  membership: {id:'fa9b427f-1998-447e-98de-ea4ce86ef221',roleCode:'agronomic_coordinator'},
  entitlements: ['scouting', 'work_orders', 'gis'] };
const obs = { id: observationId, tenant_id: tenant, scouting_run_id: runId,
  observation_type: 'pest', severity: 'critical',
  notes: 'DATO PRIVADO DE CAMPO 123', point: {type:'Point', coordinates:[-58.0,-34.0]},
  EvidenceAssets: [{content_base64:'JPG_PRIVADO'}] };
const run = {id:runId,tenant_id:tenant,campaign_field_id:campaignFieldId,
  CampaignField:{id:campaignFieldId,Field:{id:fieldId,name:'Lote PRIVADO'}},
  ScoutingObservations:[obs]};

const source = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('persisted private observation yields only an authorized inspection draft with exact field/campaign', () => {
  const draft = observationWorkOrderDraft(run,obs,session,'live');
  assert.ok(draft);
  assert.deepEqual(Object.keys(draft).sort(),[
    'campaignFieldId','fieldId','membershipId','observationId','observationType','runId',
    'scope','severity','tenantId'
  ].sort());
  assert.equal(draft.fieldId,fieldId);
  assert.equal(draft.campaignFieldId,campaignFieldId);
  assert.equal(draft.tenantId,tenant);
  assert.equal(Object.isFrozen(draft),true);
  const form=workOrderFormFromObservationDraft(draft,session,'live');
  assert.equal(form.type,'inspection');
  assert.equal(form.priority,'urgent');
  assert.equal(form.field_id,fieldId);
  assert.equal(form.campaign_field_id,campaignFieldId);
  assert.equal(form.origin_observation_id,observationId);
  assert.match(form.instructions,new RegExp(runId));
  assert.match(form.instructions,new RegExp(observationId));
  assert.equal(form.due_at,'');
  assert.equal(JSON.stringify({draft,form}).includes('DATO PRIVADO'),false);
  assert.equal(JSON.stringify({draft,form}).includes('JPG_PRIVADO'),false);
  assert.equal(JSON.stringify({draft,form}).includes('-58'),false);
  assert.equal(JSON.stringify({draft,form}).includes('Lote PRIVADO'),false);
});

test('severity is a suggestion, not an automatic agrochemical prescription or server write', () => {
  const priorities={low:'low',medium:'normal',high:'high',critical:'urgent'};
  for(const [severity,priority] of Object.entries(priorities)){
    const observation={...obs,severity};
    const draft=observationWorkOrderDraft({...run,ScoutingObservations:[observation]},observation,session,'live');
    const form=workOrderFormFromObservationDraft(draft,session,'live');
    assert.equal(form.priority,priority);
    assert.equal(form.type,'inspection');
    assert.match(form.instructions,/definir la intervención con criterio profesional/);
  }
});

test('tenant/actor/role/capability changes deny or fence a stale navigation draft', () => {
  const draft=observationWorkOrderDraft(run,obs,session,'live');
  for(const patch of [
    {tenant:{id:fieldId}},{user:{id:fieldId}},
    {membership:{...session.membership,roleCode:'scout'}},
    {membership:{...session.membership,id:fieldId}},
    {entitlements:['work_orders','gis']},
    {entitlements:['scouting','gis']},
    {entitlements:['scouting','work_orders']},
    {authenticated:false}
  ]) {
    assert.equal(workOrderFormFromObservationDraft(draft,{...session,...patch},'live'),null);
  }
  assert.equal(workOrderFormFromObservationDraft(draft,session,'mock'),null);
  assert.equal(observationWorkOrderDraft(run,obs,{...session,
    membership:{...session.membership,roleCode:'scout'}},'live'),null);
  assert.equal(observationWorkOrderDraft(run,obs,session,'mock'),null);
  assert.equal(observationWorkOrderDraft({...run,tenant_id:fieldId},obs,session,'live'),null);
  assert.equal(observationWorkOrderDraft(run,{...obs,tenant_id:fieldId},session,'live'),null);
});

test('foreign/unverified/partial source observations cannot become an order', () => {
  for(const [badRun,badObs] of [
    [run,{...obs,id:fieldId}],
    [{...run,campaign_field_id:fieldId},obs],
    [{...run,CampaignField:{...run.CampaignField,Field:{id:'other'}}},obs],
    [{...run,ScoutingObservations:[]},obs],
    [run,{...obs,scouting_run_id:fieldId}],
    [run,{...obs,severity:'unknown'}],
    [run,{...obs,observation_type:'unknown'}],
    [{...run,CampaignField:null},obs]
  ]) assert.equal(observationWorkOrderDraft(badRun,badObs,session,'live'),null);
  const draft=observationWorkOrderDraft(run,obs,session,'live');
  for(const patch of [
    {campaignFieldId:'not-uuid'},{fieldId:'not-uuid'},
    {observationType:'application'},{severity:'other'},
    {tenantId:fieldId},{membershipId:fieldId},{scope:'forged'}
  ]) assert.equal(workOrderFormFromObservationDraft({...draft,...patch},session,'live'),null);
});

test('wiring preserves operator approval, scope, campaign FK, encrypted request and recovery priority', () => {
  const app=source('../src/App.jsx');
  const scouting=source('../src/pages/ScoutingPage.jsx');
  const orders=source('../src/pages/WorkOrdersPage.jsx');
  const modal=source('../src/components/WorkOrderFormModal.jsx');
  assert.match(scouting,/observationWorkOrderDraft\(details, obs, session, dataMode\)/);
  assert.match(scouting,/onNavigate\?\.\('orders', \{ orderDraft: draft \}\)/);
  assert.match(orders,/workOrderFormFromObservationDraft\(observationDraft, session, dataMode\)/);
  assert.match(orders,/onClearObservationDraft\?\.\(\)/);
  assert.match(app,/orderDraft: focus\.orderDraft/);
  assert.match(modal,/initialObservationDraft/);
  assert.match(modal,/campaign_field_id: saved\.body\.campaign_field_id \?\? null/);
  assert.match(modal,/origin_observation_id: saved\.body\.origin_observation_id/);
  assert.match(modal,/campaign_field_id: null/);
  assert.match(modal,/contextualForm/);
  assert.match(modal,/await saveWorkOrderRecovery\(authority, body\)/);
  assert.match(modal,/requestApi\.createWorkOrder\(body\)/);
  assert.match(modal,/verifyCreatedWorkOrder\(response, body, session\?\.user\?\.id, session\?\.tenant\?\.id\)/);
  assert.doesNotMatch(modal,/source_observation_id|localStorage|sessionStorage/);
});

test('authoritative persistence is not inferred from textual references or a navigation-only token', () => {
  const router=source('../../backend/src/modules/workOrders/router.js');
  const helper=source('../../backend/src/modules/workOrders/observationOrigin.js');
  const migration=source('../../backend/db/migrations/202611030001_work_order_observation_origins.js');
  const recovery=source('../src/services/workOrderRecoveryStore.js');
  assert.match(router,/origin_observation_id: z\.string\(\)\.uuid\(\)\.optional\(\)/);
  assert.match(router,/await persistObservationOrigin\(req, order\.id, origin\)/);
  assert.match(router,/await readObservationOrigin\(req, order\.id\)/);
  assert.match(helper,/scouting_observation_id: observation\.id/);
  assert.match(helper,/run\.campaign_field_id !== input\.campaign_field_id/);
  assert.match(helper,/hasCapability\(req\.auth, req\.tenantId, 'scouting\.read'\)/);
  assert.match(migration,/FORCE ROW LEVEL SECURITY/);
  assert.match(migration,/FOREIGN KEY \(tenant_id, work_order_id, field_id, campaign_field_id\)/);
  assert.match(migration,/FOREIGN KEY \(tenant_id, scouting_observation_id, scouting_run_id, field_id\)/);
  assert.match(migration,/FOREIGN KEY \(tenant_id, scouting_run_id, campaign_field_id\)/);
  assert.match(recovery,/body\.origin_observation_id/);
  assert.doesNotMatch(helper,/\.notes|\.point|content_base64|storage_key/);
});
