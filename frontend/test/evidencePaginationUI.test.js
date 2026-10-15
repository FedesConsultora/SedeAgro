import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildRunEvidenceProvenance, parseRunEvidenceStatus } from '../src/services/runEvidenceProvenance.js';
import { sessionScope } from '../src/services/offlineSyncModel.js';

const RUN = 'a9d3b245-5296-4281-9213-3e858b010682';
const USER = '49269a2d-bf62-45ba-b9a9-a3e34ade74ee';
const TENANT = '75061102-0b6d-4a93-b691-b9f558691824';
const OBS = 'd752f70f-8b99-4d1a-89e0-bbf95b948599';
const UPLOAD = 'cb0de39a-d936-494d-93e3-d9562e456b27';
const BATCH = 'c12b90fb-11bf-44c9-afbd-43b75a8a4875';
const assetId = n => `7f94b013-067c-466a-aafe-${String(n).padStart(12, '0')}`;
const session = { authenticated:true, user:{id:USER}, tenant:{id:TENANT} };
const cursor = `${'Q'.repeat(60)}.${'R'.repeat(43)}`;
const row = (i = 1) => ({ id:assetId(i), scouting_observation_id:OBS, uploaded_by:USER,
  client_upload_id:UPLOAD, kind:'photo', mime_type:'image/png', size_bytes:12,
  bytes_available:true, captured_at:null });
const reply = (items, more, next) => ({ data: {
  run_id:RUN, limit:10, has_more:more, next_cursor:next, items
} });
const png = Buffer.from('89504e470d0a1a0a00000000','hex').toString('base64');
const draft = {
  scope:sessionScope(session), id:`${sessionScope(session)}:${BATCH}`,
  idempotencyKey:BATCH, runId:RUN, state:'pending', syncedObservationId:OBS,
  evidence:{ kind:'photo', mime_type:'image/png', original_name:'private.png',
    client_upload_id:UPLOAD, content_base64:png },
  body:{ idempotency_key:BATCH, operations:[{
    entity_type:'scouting_observation',operation:'create',entity_client_id:BATCH,
    payload:{ scouting_run_id:RUN }
  }] }
};

test('paged model enforces limit=10 and a plausible cursor, with no false missing conclusion', () => {
  const model = buildRunEvidenceProvenance(reply([row()],true,cursor), [draft],session,RUN,
    { paginated:true, expectedLimit:10 });
  assert.equal(model.items.length,1);
  assert.equal(model.nextCursor,cursor);
  assert.equal(model.localPhotos[0].status,'present');
  assert.equal(buildRunEvidenceProvenance(reply([],false,null),[draft],session,RUN,
    { paginated:true, expectedLimit:10 }).localPhotos[0].status,'outside_window');
  assert.equal(buildRunEvidenceProvenance(reply([],false,null),[draft],session,RUN,
    { paginated:false, expectedLimit:10 }).localPhotos[0].status,'not_listed');
});

test('page failure is fail-closed when missing cursor, false hasMore or forged run/size', () => {
  for (const invalid of [
    reply([row()],true,null), reply([row()],false,cursor),
    reply([row()],true,'not-token'),
    { data:{...reply([row()],true,cursor).data,limit:100} },
    { data:{...reply([row()],true,cursor).data,run_id:assetId(12)} },
    { data:{...reply([row()],true,cursor).data,items:[row(),row()]} }
  ]) assert.throws(() => parseRunEvidenceStatus(invalid,RUN,
    { paginated:true, expectedLimit:10 }));
});

test('pagination navigation does not touch bulk byte transfer or mutable local storage', () => {
  const read = path => readFileSync(new URL('../src/'+path,import.meta.url),'utf8');
  const panel = read('components/RunEvidenceProvenance.jsx');
  const api = read('services/api.js');
  const checks = read('components/EvidenceIntegrityChecks.jsx');
  assert.match(api,/getRunEvidencePage:/);
  assert.match(api,/encodeURIComponent\(cursor\)/);
  assert.match(panel,/api\.getRunEvidencePage\(runId, cursor\)/);
  assert.match(panel,/expectedLimit: 10/);
  assert.match(panel,/nextPage/);
  assert.match(panel,/previousPage/);
  assert.match(panel,/pageCursors\.slice\(0, -1\)/);
  assert.match(panel,/pageKey/);
  assert.match(panel,/<EvidenceIntegrityChecks key=\{pageKey\}/);
  assert.match(checks,/api\.getEvidenceIntegrity\(id\)/);
  assert.doesNotMatch(panel,/getEvidenceContent\(|offlineQueue\.(discard|flush|confirmApplied|recoverPhoto)/);
});
