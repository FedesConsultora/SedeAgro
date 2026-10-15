import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRunEvidenceProvenance, parseRunEvidenceStatus } from '../src/services/runEvidenceProvenance.js';
import { sessionScope } from '../src/services/offlineSyncModel.js';

const TENANT = 'a9187672-0623-4f55-b37d-6bb69c104bfa';
const USER = 'da2d33e2-a3fb-47f1-88e8-05d3f065f440';
const OTHER = '5e2d09b3-4df0-4fb8-83d9-694fbcb0a5b7';
const RUN = '86d65065-73bc-491a-90b9-11867850da09';
const OTHER_RUN = '6ce61ae6-419f-446a-8267-f9a7a61b57cd';
const OBS = '5ce78d06-b5f1-4d2b-8a2a-43ba80ad1b4c';
const UPLOAD = '704bf5b0-2119-4aca-8cbb-7694cb86bfa8';
const ASSET = 'f5f08148-9583-4b2b-8e5c-96c47b5a2a62';
const IDEMPOTENCY = '7d3dbd3c-67b1-4cc3-a719-f72497477a30';
const png = Buffer.from('89504e470d0a1a0a00000000', 'hex').toString('base64');
const session = { authenticated: true, user: { id: USER }, tenant: { id: TENANT } };
const photo = { kind: 'photo', mime_type: 'image/png', original_name: 'lote.png',
  content_base64: png, client_upload_id: UPLOAD };
const asset = (patch = {}) => ({
  id: ASSET, scouting_observation_id: OBS, uploaded_by: USER, client_upload_id: UPLOAD,
  kind: 'photo', mime_type: 'image/png', size_bytes: 12,
  bytes_available: true, captured_at: '2026-10-15T11:00:00Z', ...patch
});
const reply = (items = [asset()], has_more = false, run_id = RUN) => ({
  data: { run_id, limit: 100, has_more, items }
});
const draft = (overrides = {}) => ({
  scope: sessionScope(session),
  id: `${sessionScope(session)}:${IDEMPOTENCY}`,
  idempotencyKey: IDEMPOTENCY,
  runId: RUN, createdAt: '2026-10-15T10:00:00Z',
  state: 'conflict',
  syncedObservationId: OBS,
  evidence: photo,
  body: { idempotency_key: IDEMPOTENCY,
    operations: [{ entity_type: 'scouting_observation', operation: 'create',
      entity_client_id: IDEMPOTENCY, payload: { scouting_run_id: RUN } }] },
  ...overrides
});

test('server must identify exact authorized run and bounded evidence contract', () => {
  const data = parseRunEvidenceStatus(reply(), RUN);
  assert.equal(data.photosWithBytes, 1);
  assert.equal(data.missingBytes, 0);
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].observationId, OBS);
  assert.throws(() => parseRunEvidenceStatus(reply([asset()], false, OTHER_RUN), RUN));
  assert.throws(() => parseRunEvidenceStatus({ data: { ...reply().data, limit: 200 } }, RUN));
  assert.throws(() => parseRunEvidenceStatus({ data: { ...reply().data, has_more: 'false' } }, RUN));
  assert.throws(() => parseRunEvidenceStatus(reply(Array(101).fill(asset())), RUN));
  assert.throws(() => parseRunEvidenceStatus(reply([asset(), asset()]), RUN));
});

test('local photographic upload UUID + actor + size + mime + observation prove only stored byte presence', () => {
  const result = buildRunEvidenceProvenance(reply(), [draft()], session, RUN);
  assert.equal(result.localPhotos[0].status, 'present');
  assert.equal(result.localPhotos[0].evidenceId, ASSET);
  assert.equal(result.photosWithBytes, 1);
  assert.equal(result.localPhotos.length, 1);
  assert.equal(Object.hasOwn(result.localPhotos[0], 'content_base64'), false);
  const text = JSON.stringify(result);
  assert.ok(!text.includes(png));
  assert.ok(!text.includes('lote.png'));
  assert.ok(!text.includes('content_base64'));
});

test('metadata-only asset is not a successful stored-photo status', () => {
  const result = buildRunEvidenceProvenance(reply([asset({ bytes_available: false })]),
    [draft()], session, RUN);
  assert.equal(result.photosWithBytes, 0);
  assert.equal(result.missingBytes, 1);
  assert.equal(result.localPhotos[0].status, 'metadata_only');
});

test('actor, observation, byte count and MIME mismatches never count as matching photo', () => {
  for (const patch of [
    { uploaded_by: OTHER }, { scouting_observation_id: OTHER_RUN },
    { mime_type: 'image/jpeg' }, { size_bytes: 13 }, { kind: 'document', mime_type: 'application/pdf' }
  ]) {
    const result = buildRunEvidenceProvenance(reply([asset(patch)]), [draft()], session, RUN);
    assert.equal(result.localPhotos[0].status,
      patch.uploaded_by ? 'not_listed' : 'mismatch');
    assert.equal(result.localPhotos[0].evidenceId, null);
  }
  const stolenScope = draft({ scope: `${TENANT}:${OTHER}` });
  assert.throws(() => buildRunEvidenceProvenance(reply(), [stolenScope], session, RUN));
  assert.throws(() => buildRunEvidenceProvenance(reply(), [draft()], {
    ...session, user: { id: OTHER }
  }, RUN));
});

test('absence in bounded window is explicitly unknown, never proof of server failure', () => {
  assert.equal(buildRunEvidenceProvenance(reply([]), [draft()], session, RUN)
    .localPhotos[0].status, 'not_listed');
  assert.equal(buildRunEvidenceProvenance(reply([], true), [draft()], session, RUN)
    .localPhotos[0].status, 'outside_window');
  assert.equal(buildRunEvidenceProvenance(reply(), [draft({ runId: OTHER_RUN })],
    session, RUN).localPhotos.length, 0);
});

test('invalid photo identity or duplicate local rows fail closed rather than infer', () => {
  assert.throws(() => buildRunEvidenceProvenance(reply(), [draft(), draft()], session, RUN));
  assert.throws(() => buildRunEvidenceProvenance(reply(), [draft({
    evidence: { ...photo, client_upload_id: 'invalid' }
  })], session, RUN));
  assert.throws(() => buildRunEvidenceProvenance(reply(), [draft({
    syncedObservationId: 'invalid'
  })], session, RUN));
  assert.throws(() => buildRunEvidenceProvenance(reply(), [draft({
    body: { idempotency_key: IDEMPOTENCY, operations: [{
      entity_type: 'scouting_observation', operation: 'create',
      payload: { scouting_run_id: OTHER_RUN }
    }] }
  })], session, RUN));
  assert.throws(() => buildRunEvidenceProvenance(reply([asset({
    bytes_available: 'yes'
  })]), [], session, RUN));
});
