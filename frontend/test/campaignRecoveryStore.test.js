import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('campaign recovery persists sealed bytes before the first network POST', () => {
  const store = source('../src/services/campaignRecoveryStore.js');
  const modal = source('../src/components/CampaignFormModal.jsx');
  assert.match(store, /AES-GCM/);
  assert.match(store, /length: 256/);
  assert.match(store, /false, \['encrypt', 'decrypt'\]/);
  assert.match(store, /additionalData: additionalData\(scope, body.client_request_id\)/);
  assert.match(store, /tx\.objectStore\(PENDING\)\.add\(/);
  assert.match(store, /getOne\(PENDING, scope\)/);
  assert.match(store, /tx\.objectStore\(table\)\.get\(scope\)/);
  assert.match(store, /request\.result\?\.id !== requestId/);
  assert.doesNotMatch(store, /localStorage|sessionStorage|Authorization|Bearer/);
  assert.match(modal, /await saveCampaignRecovery\(authority, body\);/);
  assert.match(modal, /void sendCreate\(ticket, body, api\);/);
  assert.ok(modal.indexOf('await saveCampaignRecovery(authority, body)') <
    modal.indexOf('void sendCreate(ticket, body, api)'));
  assert.match(modal, /readCampaignRecovery\(authority\)/);
  assert.match(modal, /await discardCampaignRecovery\(authority, body.client_request_id\)/);
  assert.match(modal, /submitGate\.current\.isPending\(authority\)/);
});

test('restoration is a user-confirmed manual operation and never resends automatically', () => {
  const modal = source('../src/components/CampaignFormModal.jsx');
  const restore = modal.slice(modal.indexOf('void readCampaignRecovery(authority)'),
    modal.indexOf('  }, [isOpen, authority, api]);'));
  assert.match(restore, /setSubmitStatus\('uncertain'\)/);
  assert.doesNotMatch(restore, /sendCreate\(/);
  assert.match(modal, /window\.confirm\(/);
  assert.match(modal, /Reintentar el mismo envío/);
  assert.match(modal, /Descartar tras revisar Campañas/);
  assert.match(modal, /recoveryLoading \|\| recoveryBlocked/);
  assert.match(modal, /scopeRef\.current !== authority/);
  assert.match(modal, /apiRef\.current !== api/);
});
