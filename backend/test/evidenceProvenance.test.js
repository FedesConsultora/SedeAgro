import test from 'node:test';
import assert from 'node:assert/strict';
import { evidenceProvenanceView, RUN_EVIDENCE_LIMIT } from '../src/modules/scouting/evidenceProvenance.js';

const id = n => `94de8039-a726-42c7-936f-${n.toString(16).padStart(12, '0')}`;
const asset = n => ({
  id: id(n), scouting_observation_id: id(401), uploaded_by: id(402),
  client_upload_id: id(403 + n), kind: 'photo', mime_type: 'image/jpeg',
  size_bytes: 124, captured_at: '2026-10-15T10:00:00Z',
  storage_key: 'private-secret', content: Buffer.from('never expose'),
  content_sha256: 'sha256-private-digest', original_name: 'private.jpg'
});

test('evidence provenance is explicitly bounded to 100 and preserves window signal', () => {
  assert.equal(RUN_EVIDENCE_LIMIT, 100);
  const rows = Array.from({ length: 101 }, (_, index) => asset(index + 1));
  const result = evidenceProvenanceView(rows, rows.slice(0, 2).map(row => row.id), id(999));
  assert.equal(result.items.length, 100);
  assert.equal(result.has_more, true);
  assert.equal(result.limit, 100);
  assert.equal(result.items[0].bytes_available, true);
  assert.equal(result.items[1].bytes_available, true);
  assert.equal(result.items[2].bytes_available, false);
  assert.equal(result.items.at(-1).bytes_available, false);
  assert.equal(result.run_id, id(999));
});

test('private bytes, metadata secrets, names and source hash never enter the response', () => {
  const result = evidenceProvenanceView([asset(1)], [id(1)], id(999));
  const encoded = JSON.stringify(result);
  for (const privateValue of ['private-secret', 'never expose', 'sha256-private-digest',
    'private.jpg', 'storage_key', 'content_base64', 'original_name', 'content_sha256']) {
    assert.equal(encoded.includes(privateValue), false);
  }
  assert.deepEqual(Object.keys(result.items[0]).sort(), [
    'bytes_available', 'captured_at', 'client_upload_id', 'id', 'kind', 'mime_type',
    'scouting_observation_id', 'size_bytes', 'uploaded_by'
  ].sort());
});

test('missing blob does not get a false availability status from metadata', () => {
  const row = asset(1);
  assert.equal(evidenceProvenanceView([row], [], id(999)).items[0].bytes_available, false);
  assert.equal(evidenceProvenanceView([], [], id(999)).has_more, false);
});
