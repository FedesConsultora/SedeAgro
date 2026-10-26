import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { saveWorkOrderRecovery } from '../src/services/workOrderRecoveryStore.js';

const source = file => readFileSync(new URL(file, import.meta.url), 'utf8');

test('work-order replay uses a dedicated encrypted IndexedDB namespace', () => {
  const wrapper = source('../src/services/workOrderRecoveryStore.js');
  const core = source('../src/services/encryptedCreateJournal.js');
  assert.match(wrapper, /databaseName: 'sedeagro-work-order-recovery'/);
  assert.match(wrapper, /aadDomain: 'sedeagro:work-order-recovery:v1:'/);
  assert.match(wrapper, /UUID\.test\(body\.field_id/);
  assert.match(wrapper, /TYPES\.has\(body\.type\)/);
  assert.match(wrapper, /PRIORITIES\.has\(body\.priority\)/);
  assert.match(wrapper, /new Date\(body\.due_at\)\.toISOString\(\) === body\.due_at/);
  assert.match(core, /AES-GCM/);
  assert.match(core, /false, \['encrypt', 'decrypt'\]/);
  assert.match(core, /tx\.objectStore\(PENDING\)\.add\(/);
  assert.match(core, /request\.result\?\.id !== requestId/);
  assert.doesNotMatch(core, /localStorage|sessionStorage|Authorization|Bearer/);
  for (const [path, aad] of [
    ['campaignRecoveryStore.js','campaign-recovery:v1:'],
    ['scoutingRunRecoveryStore.js','scouting-run-recovery:v1:']
  ]) {
    const other = source('../src/services/' + path);
    assert.match(other,new RegExp(aad));
    assert.doesNotMatch(other,/sedeagro-work-order-recovery/);
  }
});

test('invalid work order is rejected before accessing browser IndexedDB or dispatching HTTP', async () => {
  const good = {
    client_request_id: '9d000000-0000-4000-8000-000000000001',
    field_id: '9d000000-0000-4000-8000-000000000002',
    type: 'inspection', priority: 'normal', title: 'Inspeccionar lote'
  };
  for (const patch of [
    { field_id: 'foreign id' }, { type: 'delete' }, { priority: 'critical' },
    { title: 'x' }, { due_at: '2026-11-01T09:00:00-03:00' },
    { campaign_field_id: 'not-uuid' }, { status: 'approved' },
    { client_request_id: 'not-uuid' }
  ]) {
    await assert.rejects(
      saveWorkOrderRecovery('tenant:actor:membership', { ...good, ...patch }),
      /identidad recuperable/i
    );
  }
});

test('modal saves original UUID/body before POST and never auto-replays on restore', () => {
  const modal = source('../src/components/WorkOrderFormModal.jsx');
  assert.match(modal,/workOrderCreateScope\(session, dataMode\)/);
  assert.match(modal,/readWorkOrderRecovery\(authority\)/);
  assert.match(modal,/await saveWorkOrderRecovery\(authority, body\)/);
  assert.match(modal,/void sendCreate\(ticket, body, api\)/);
  const liveCreate = modal.slice(modal.indexOf('await saveWorkOrderRecovery(authority, body)'),
    modal.indexOf("submitGate.current.finish(ticket, 'preflight-rejected')"));
  assert.ok(liveCreate.indexOf('await saveWorkOrderRecovery(authority, body)') <
    liveCreate.indexOf('void sendCreate(ticket, body, api)'),
    'the live branch must commit encrypted data before network dispatch');
  assert.match(modal, /if \(dataMode === 'mock'\) \{[\s\S]*?void sendCreate\(ticket, body, api\)/);
  assert.match(modal,/await discardWorkOrderRecovery\(authority, body.client_request_id\)/);
  assert.match(modal,/requestRef\.current = \{ scope: authority, api, body: saved\.body \}/);
  assert.match(modal,/verifyCreatedWorkOrder\(response, body, session\?\.user\?\.id, session\?\.tenant\?\.id\)/);
  assert.match(modal,/scopeRef\.current !== authority/);
  assert.match(modal,/apiRef\.current !== api/);
  assert.match(modal,/submitGate\.current\.isPending\(authority\)/);
  assert.match(modal,/window\.confirm\(/);
  assert.match(modal,/Reintentar el mismo envío/);
  assert.match(modal,/Descartar tras revisar Órdenes/);
  assert.match(modal,/dataMode === 'mock'/);
  assert.match(modal,/dataMode === 'live'/);
  assert.doesNotMatch(modal,/localStorage|sessionStorage/);

  const restored = modal.slice(modal.indexOf('void readWorkOrderRecovery(authority)'),
    modal.indexOf('  }, [isOpen, authority, api, dataMode]);'));
  assert.doesNotMatch(restored, /sendCreate\(/, 'restoring may never dispatch a POST automatically');
});

test('new work order and previous authority cannot render each other private forms', () => {
  const modal = source('../src/components/WorkOrderFormModal.jsx');
  assert.match(modal,/formSnapshot\?\.scope === authority/);
  assert.match(modal,/formSnapshot\?\.api === api/);
  assert.match(modal,/recoveryState\?\.scope === authority/);
  assert.match(modal,/recoveryState\?\.api === api/);
  assert.match(modal,/recoveryLoading \|\| recoveryBlocked/);
});
