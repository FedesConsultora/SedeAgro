import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MAX_OBSERVATION_ORDER_LINKS,
  observationWorkOrderLinkScope, checkedObservationWorkOrderLinks,
  visibleObservationWorkOrderLinks
} from '../src/services/observationWorkOrderLinks.js';

const tenant = '144a2498-a61f-48c6-9fda-53dcb09c8aaa';
const actor = 'cc1b727c-b58a-4f10-9fc6-b8858bfda116';
const membership = 'aa7c9854-52bb-49a5-81e0-eb65d11ac224';
const run = '2bc75942-d3c3-4b64-8fbc-5e1f8e30a830';
const obs = 'b26e8302-8edb-46ee-9503-73a876a12752';
const otherObs = '88d1efc6-9f2e-47bb-bf66-bc123d9ecb52';
const order = '9a84302d-2057-413e-9661-8b188a3be63b';
const session = {
  authenticated: true,
  tenant: {id:tenant}, user:{id:actor},
  membership:{id:membership,roleCode:'tenant_admin'},
  entitlements:['scouting','work_orders','gis','org']
};
const row = {
  scouting_observation_id:obs, work_order_id:order,
  title:'Verificar plaga en el lote', status:'draft', type:'inspection', priority:'high'
};
const response = data => ({data:{scoutingRunId:run,rows:data}});

test('reverse provenance is private to live admin/coordinator with BOTH modules and exact membership',()=>{
  const scope=observationWorkOrderLinkScope(session,'live');
  assert.ok(scope);
  assert.ok(observationWorkOrderLinkScope({...session,
    membership:{...session.membership,roleCode:'agronomic_coordinator'}},'live'));
  for(const [bad,mode] of [
    [{membership:{...session.membership,roleCode:'scout'}},'live'],
    [{membership:{...session.membership,roleCode:'contractor'}},'live'],
    [{entitlements:['scouting','gis']},'live'],
    [{entitlements:['work_orders','gis']},'live'],
    [{authenticated:false},'live'],
    [{user:{}},'live'],
    [{membership:{roleCode:'tenant_admin'}},'live'],
    [{tenant:{id:actor}},'mock']
  ]) assert.equal(observationWorkOrderLinkScope({...session,...bad},mode),null);
  assert.notEqual(scope,observationWorkOrderLinkScope({
    ...session, membership:{...session.membership,id:otherObs}
  },'live'),'different membership invalidates cached links');
});

test('server link response is exactly one known scouting run, with no private fields',()=>{
  assert.deepEqual(checkedObservationWorkOrderLinks(response([row]),run,[{id:obs}]),[row]);
  assert.deepEqual(checkedObservationWorkOrderLinks(response([]),run,[{id:obs}]),[]);
  assert.throws(()=>checkedObservationWorkOrderLinks({
    data:{scoutingRunId:otherObs,rows:[row]}
  },run,[{id:obs}]),/no confirmó/);
  for(const broken of [
    [{...row,scouting_observation_id:otherObs}],
    [{...row,work_order_id:'bad-id'}],
    [{...row,notes:'private observation'}],
    [{...row,latitude:-34.6}],
    [{...row,evidence_assets:[]}],
    [{...row,title:''}],
    [{...row,status:'verified'}],
    [{...row,priority:'critical'}],
    [{...row,type:'pesticide'}],
    [row,row],
    Array.from({length:MAX_OBSERVATION_ORDER_LINKS+1},()=>row)
  ]) assert.throws(()=>checkedObservationWorkOrderLinks(
    response(broken),run,[{id:obs}]),/inválido|ajenos/);
  assert.throws(()=>checkedObservationWorkOrderLinks(response({}),run,[{id:obs}]),/inválido/);
  assert.throws(()=>checkedObservationWorkOrderLinks(response([row]),run,[{id:'foreign'}]),/no confirmó/);
});

test('UI never renders old tenant/transport/revision link snapshot and route rechecks selected order',()=>{
  const scope=observationWorkOrderLinkScope(session,'live');
  const api={};
  const snapshot={scope,api,runId:run,revision:1,phase:'ready',rows:[row]};
  assert.equal(visibleObservationWorkOrderLinks(snapshot,scope,api,run,1),snapshot);
  assert.equal(visibleObservationWorkOrderLinks(snapshot,scope,{},run,1),null);
  assert.equal(visibleObservationWorkOrderLinks(snapshot,'foreign',api,run,1),null);
  assert.equal(visibleObservationWorkOrderLinks(snapshot,scope,api,otherObs,1),null);
  assert.equal(visibleObservationWorkOrderLinks(snapshot,scope,api,run,2),null);
  const page=readFileSync(new URL('../src/pages/ScoutingPage.jsx',import.meta.url),'utf8');
  const orders=readFileSync(new URL('../src/pages/WorkOrdersPage.jsx',import.meta.url),'utf8');
  const backend=readFileSync(new URL('../../backend/src/modules/workOrders/observationLinks.js',import.meta.url),'utf8');
  const route=readFileSync(new URL('../../backend/src/modules/workOrders/router.js',import.meta.url),'utf8');
  assert.match(page,/checkedObservationWorkOrderLinks\(/);
  assert.match(page,/visibleObservationWorkOrderLinks\(/);
  assert.match(page,/linkScopeRef\.current === requestScope/);
  assert.match(page,/linkApiRef\.current === requestApi/);
  assert.match(page,/onOpenWorkOrder=\{id => onNavigate\?\.\('orders', \{ id \}\)\}/);
  assert.match(page,/Sin órdenes con origen registrado/);
  assert.match(orders,/focusOrderId/);
  assert.match(orders,/api\.workOrders\(\)/);
  assert.match(backend,/canReadObservationOrigin\(req\)/);
  assert.match(backend,/INNER JOIN work_orders AS orders/);
  assert.match(backend,/MAX_OBSERVATION_ORDER_LINKS \+ 1/);
  assert.match(backend,/ORDER_OBSERVATION_LINKS_LIMIT/);
  assert.match(route,/requireCapability\('orders\.read'\)/);
  assert.match(route,/Cache-Control', 'private, no-store'/);
  assert.doesNotMatch(page,/localStorage\.setItem\('sedeagro\.work-order-origin/);
});
