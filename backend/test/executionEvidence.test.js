import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canAttachExecutionEvidence, sameExecutionUpload, visibleExecutionEvidence,
  EXECUTION_EVIDENCE_LIMIT, ORDER_EVIDENCE_LIMIT
} from '../src/modules/workOrders/executionEvidencePolicy.js';

test('only the actual reporter can attach to a pending execution, within a hard count', () => {
  const base = { orderStatus: 'in_progress', reviewStatus: 'submitted',
    uploaderId: 'u1', submitterId: 'u1', count: 0 };
  assert.equal(canAttachExecutionEvidence(base), true);
  assert.equal(canAttachExecutionEvidence({ ...base, uploaderId: 'u2' }), false);
  assert.equal(canAttachExecutionEvidence({ ...base, reviewStatus: 'verified' }), false);
  assert.equal(canAttachExecutionEvidence({ ...base, reviewStatus: 'rejected' }), false);
  assert.equal(canAttachExecutionEvidence({ ...base, orderStatus: 'completed' }), false);
  assert.equal(canAttachExecutionEvidence({ ...base, count: 8 }), false);
  assert.equal(canAttachExecutionEvidence({ ...base, count: -1 }), false);
  assert.equal(EXECUTION_EVIDENCE_LIMIT, 8);
  assert.equal(ORDER_EVIDENCE_LIMIT, 160);
});

test('idempotency confirms exact order, report, content and original MIME/name', () => {
  const record = { work_order_id: 'o1', work_order_execution_id: 'x1',
    content_sha256: 'sha', kind: 'photo', mime_type: 'image/jpeg', original_name: 'a.jpg' };
  const context = { orderId: 'o1', executionId: 'x1', digest: 'sha',
    kind: 'photo', mimeType: 'image/jpeg', originalName: 'a.jpg' };
  assert.equal(sameExecutionUpload(record, context), true);
  assert.equal(sameExecutionUpload(record, { ...context, executionId: 'x2' }), false);
  assert.equal(sameExecutionUpload(record, { ...context, digest: 'different' }), false);
  assert.equal(sameExecutionUpload(record, { ...context, orderId: 'o2' }), false);
  assert.equal(sameExecutionUpload(record, { ...context, originalName: 'other.jpg' }), false);
});

test('public metadata excludes private hash, raw bytes, GPS and storage key', () => {
  const record = { id: 'id1', work_order_execution_id: 'x1', original_name: 'proof.pdf',
    kind: 'document', mime_type: 'application/pdf', size_bytes: 34,
    uploaded_by: 'operator', created_at: '2026-10-15', storage_key: 'PRIVATE',
    content_sha256: 'HASH_SECRET', point: 'COORD_PRIVATE', content_base64: 'BLOB_SECRET' };
  const publicView = visibleExecutionEvidence(record);
  assert.equal(publicView.id, 'id1');
  assert.doesNotMatch(JSON.stringify(publicView), /HASH_SECRET|PRIVATE|COORD_PRIVATE|BLOB_SECRET/);
});
