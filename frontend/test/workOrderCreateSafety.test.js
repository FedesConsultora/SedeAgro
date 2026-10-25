import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  workOrderCreateScope, verifyCreatedWorkOrder, createWorkOrderSubmitGate
} from '../src/services/workOrderCreateSafety.js';

const tenant = '9d941d8a-9a66-4c6d-8469-54c37596e3a9';
const actor = '7d51278a-7a9b-4f02-817c-1b2079a6d748';
const field = 'b5f05b5f-1132-4342-b385-c004443f2cd9';
const orderId = 'b2774253-4071-4a68-9ec4-e9507a6ebd1e';
const session = { authenticated: true, tenant: { id: tenant }, user: { id: actor },
  membership: {roleCode:'agronomic_coordinator'}, entitlements:['work_orders','gis'] };
const request = {field_id:field,title:'Control de malezas',type:'inspection',
  priority:'normal',instructions:'Verificar cabecera norte'};
const reply = {data:{id:orderId, requested_by:actor, ...request,status:'draft'}};

test('creation only permitted to active authenticated work-order creators', () => {
  const scope = workOrderCreateScope(session, 'live');
  assert.ok(scope);
  assert.equal(workOrderCreateScope({...session, entitlements:['gis','work_orders','gis']},'live'),scope);
  assert.notEqual(workOrderCreateScope({...session, tenant:{id:orderId}},'live'),scope);
  assert.notEqual(workOrderCreateScope({...session, user:{id:orderId}},'live'),scope);
  assert.notEqual(workOrderCreateScope({...session, membership:{roleCode:'tenant_admin'}},'live'),scope);
  assert.notEqual(workOrderCreateScope({...session, entitlements:['work_orders']},'live'),scope);
  for (const alt of [
    {...session,authenticated:false}, {...session, membership:{roleCode:'scout'}},
    {...session,entitlements:[]}, {...session,user:{}}, {...session,tenant:{}}, null
  ]) assert.equal(workOrderCreateScope(alt,'live'),null);
  assert.equal(workOrderCreateScope(session,'mock'),'demo');
});

test('201 new work order confirmed only for exact actor, field, title and draft', () => {
  assert.equal(verifyCreatedWorkOrder(reply,request,actor),reply.data);
  for (const patch of [
    {id:''}, {id:'forged'}, {requested_by:orderId}, {field_id:orderId},
    {title:'Orden equivocada'}, {type:'harvest'}, {priority:'high'}, {status:'approved'}
  ]) assert.throws(()=>verifyCreatedWorkOrder({data:{...reply.data,...patch}},request,actor),
    /no confirmó la orden solicitada/i);
  for(const invalid of [null,{}, {data:null},{data:[]},{data:{}}]) {
    assert.throws(()=>verifyCreatedWorkOrder(invalid,request,actor),/no confirmó/i);
  }
  assert.throws(()=>verifyCreatedWorkOrder(reply,{...request,field_id:orderId},actor),/no confirmó/i);
  assert.throws(()=>verifyCreatedWorkOrder(reply,request,orderId),/no confirmó/i);
});

test('double tap before render and success keep one create ticket until modal reset', () => {
  const gate=createWorkOrderSubmitGate();
  const scope=workOrderCreateScope(session,'live');
  const ticket=gate.acquire(scope);
  assert.ok(ticket);
  assert.equal(gate.acquire(scope),null);
  assert.equal(gate.isPending(scope),true);
  assert.equal(gate.finish(ticket,'confirmed'),true);
  assert.equal(gate.isPending(scope),false);
  assert.equal(gate.isBlocked(scope),true);
  assert.equal(gate.acquire(scope),null);
  gate.reset();
  assert.ok(gate.acquire(scope));
});

test('ambiguous response after POST locks same modal; new modal may be created after checking list', () => {
  const gate=createWorkOrderSubmitGate();
  const scope=workOrderCreateScope(session,'live');
  const first=gate.acquire(scope);
  assert.equal(gate.finish(first,'uncertain'),true);
  assert.equal(gate.acquire(scope),null);
  assert.equal(gate.isBlocked(scope),true);
  gate.reset();
  assert.ok(gate.acquire(scope));
});

test('pre-dispatch rejection permits retry but stale completion cannot unlock new scope', () => {
  const gate=createWorkOrderSubmitGate();
  const original=gate.acquire(workOrderCreateScope(session,'live'));
  assert.equal(gate.finish(original,'preflight-rejected'),true);
  assert.ok(gate.acquire(workOrderCreateScope(session,'live')));
  gate.reset();
  const newScope=workOrderCreateScope({...session,tenant:{id:orderId}},'live');
  const latest=gate.acquire(newScope);
  assert.equal(gate.finish(original,'uncertain'),false);
  assert.equal(gate.isPending(newScope),true);
  assert.equal(gate.finish(latest,'confirmed'),true);
  assert.equal(gate.isBlocked(newScope),true);
});

test('simultaneous asynchronous POSTs under one scope dispatch at most once', async () => {
  const gate=createWorkOrderSubmitGate();
  let release;let started;
  const pending=new Promise(resolve=>{release=resolve;});
  const begun=new Promise(resolve=>{started=resolve;});
  const scope=workOrderCreateScope(session,'live');
  let posts=0;
  async function submit(){
    const ticket=gate.acquire(scope);
    if(!ticket)return 'blocked';
    posts++;started();
    try{await pending;verifyCreatedWorkOrder(reply,request,actor);
      gate.finish(ticket,'confirmed');return 'confirmed';
    }catch{gate.finish(ticket,'uncertain');return 'unconfirmed';}
  }
  const first=submit();await begun;
  assert.equal(await submit(),'blocked');
  assert.equal(posts,1);
  release();
  assert.equal(await first,'confirmed');
  assert.equal(await submit(),'blocked');
  assert.equal(posts,1);
});

const source=path=>readFileSync(new URL(path,import.meta.url),'utf8');
test('form validates receipt, gates submit and prevents close during pending POST',()=>{
  const jsx=source('../src/components/WorkOrderFormModal.jsx');
  assert.match(jsx,/workOrderCreateScope\(session, dataMode\)/);
  assert.match(jsx,/submitGate\.current\.acquire\(authority\)/);
  assert.match(jsx,/verifyCreatedWorkOrder\(response, body, session\?\.user\?\.id\)/);
  assert.match(jsx,/submitGate\.current\.finish\(ticket, 'uncertain'\)/);
  assert.match(jsx,/submitGate\.current\.isPending\(authority\)/);
  assert.match(jsx,/scopeRef\.current === authority/);
  assert.match(jsx,/fieldsSnapshot\?\.scope === authority/);
  assert.match(jsx,/onClose=\{safeClose\}/);
  assert.doesNotMatch(jsx,/await api\.createWorkOrder\(body\);\s*onCreated\(\)/);
});


test('keyed create receipt checks replay flag, tenant and all immutable order data', () => {
  const body = { ...request, client_request_id: orderId };
  const response = { ...reply, replayed: false,
    data: { ...reply.data, tenant_id: tenant, campaign_field_id: null,
      due_at: null, instructions: request.instructions } };
  assert.equal(verifyCreatedWorkOrder(response, body, actor, tenant), response.data);
  assert.equal(verifyCreatedWorkOrder({ ...response, replayed: true }, body, actor, tenant), response.data);
  for (const patch of [
    { tenant_id: field }, { instructions: 'Another result' },
    { campaign_field_id: field }, { due_at: '2026-11-01T00:00:00.000Z' },
    { status: 'assigned' }
  ]) assert.throws(() => verifyCreatedWorkOrder({
    ...response, data: { ...response.data, ...patch }
  }, body, actor, tenant), /no confirmó/i);
  for (const flag of [null, undefined, 0, 'true']) {
    assert.throws(() => verifyCreatedWorkOrder({ ...response, replayed: flag },
      body, actor, tenant), /no confirmó/i);
  }
  assert.equal(verifyCreatedWorkOrder(reply, request, actor), reply.data);
});

test('manual retry of uncertain receipt is serialized and rejects stale original tickets', () => {
  const gate = createWorkOrderSubmitGate();
  const scope = workOrderCreateScope(session, 'live');
  assert.equal(gate.retry(scope), null);
  const original = gate.acquire(scope);
  assert.equal(gate.retry(scope), null);
  assert.equal(gate.finish(original, 'uncertain'), true);
  assert.equal(gate.acquire(scope), null);
  assert.equal(gate.retry('other-scope'), null);
  const retry = gate.retry(scope);
  assert.ok(retry);
  assert.equal(gate.retry(scope), null);
  assert.equal(gate.finish(original, 'confirmed'), false);
  assert.equal(gate.finish(retry, 'confirmed'), true);
  assert.equal(gate.retry(scope), null);
  gate.reset();
  assert.equal(gate.finish(retry, 'uncertain'), false);
});

test('keyed work order form never silently regenerates body on retry', () => {
  const jsx = source('../src/components/WorkOrderFormModal.jsx');
  assert.match(jsx, /crypto\.randomUUID\(\)/);
  assert.match(jsx, /client_request_id:/);
  assert.match(jsx, /Object\.freeze\(/);
  assert.match(jsx, /requestRef\.current =/);
  assert.match(jsx, /submitGate\.current\.retry\(authority\)/);
  assert.match(jsx, /sendCreate\(ticket, saved\.body, saved\.api\)/);
  assert.match(jsx, /verifyCreatedWorkOrder\(response, body, session\?\.user\?\.id, session\?\.tenant\?\.id\)/);
  assert.doesNotMatch(jsx, /localStorage|sessionStorage/);
});
