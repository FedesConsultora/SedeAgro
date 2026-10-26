import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('scouting journal is isolated from campaign drafts and uses a separate AES-GCM domain', () => {
  const source = read('../src/services/scoutingRunRecoveryStore.js');
  const campaign = read('../src/services/campaignRecoveryStore.js');
  const core = read('../src/services/encryptedCreateJournal.js');
  assert.match(source, /databaseName: 'sedeagro-scouting-run-recovery'/);
  assert.match(source, /aadDomain: 'sedeagro:scouting-run-recovery:v1:'/);
  assert.match(source, /UUID\.test\(body\.campaign_field_id/);
  assert.match(source, /UUID\.test\(body\.assigned_to\)/);
  assert.match(campaign, /databaseName: 'sedeagro-campaign-recovery'/);
  assert.match(campaign, /aadDomain: 'sedeagro:campaign-recovery:v1:'/);
  assert.match(core, /AES-GCM/);
  assert.match(core, /false, \['encrypt', 'decrypt'\]/);
  assert.match(core, /tx\.objectStore\(PENDING\)\.add\(/);
  assert.match(core, /request\.result\?\.id !== requestId/);
  assert.doesNotMatch(core, /localStorage|sessionStorage|Authorization/);
});

test('scouting modal persists immutable body before HTTP and restores only by actor and scope', () => {
  const source = read('../src/components/ScoutingRunFormModal.jsx');
  assert.match(source, /scoutingRunCreateScope\(session, dataMode\)/);
  assert.match(source, /readScoutingRunRecovery\(authority\)/);
  assert.match(source, /await saveScoutingRunRecovery\(authority, body\);/);
  assert.match(source, /void sendCreate\(ticket, body, api\);/);
  assert.ok(source.indexOf('await saveScoutingRunRecovery(authority, body)') <
    source.indexOf('void sendCreate(ticket, body, api)'));
  assert.match(source, /await discardScoutingRunRecovery\(authority, body.client_request_id\)/);
  assert.match(source, /setSubmitStatus\('uncertain'\)/);
  assert.match(source, /scopeRef\.current !== authority/);
  assert.match(source, /apiRef\.current !== api/);
  assert.match(source, /requestRef\.current = \{ scope: authority, api, body: saved.body \}/);
  assert.match(source, /window\.confirm\(/);
  assert.match(source, /Reintentar el mismo envío/);
  assert.match(source, /Descartar tras revisar Recorridas/);
  assert.doesNotMatch(source, /localStorage|sessionStorage/);
});
