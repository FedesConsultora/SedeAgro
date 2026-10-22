import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MAX_EXECUTION_FILE_BYTES, canUploadExecutionEvidence,
  validateExecutionFile, validateExecutionEvidenceResponse, decodePrivateEvidenceResponse
} from '../src/services/executionEvidence.js';

const report = (status = 'submitted', by = 'worker') => ({
  id: 'x1', submitted_by: by, review_status: status
});
const acceptedFile = { size: 500, type: 'image/png', name: 'lote.png' };

test('upload button is limited to report author while review is pending in live mode', () => {
  assert.equal(canUploadExecutionEvidence(report(), 'in_progress', 'worker', true), true);
  assert.equal(canUploadExecutionEvidence(report(), 'in_progress', 'another', true), false);
  assert.equal(canUploadExecutionEvidence(report('verified'), 'in_progress', 'worker', true), false);
  assert.equal(canUploadExecutionEvidence(report('rejected'), 'in_progress', 'worker', true), false);
  assert.equal(canUploadExecutionEvidence(report(), 'completed', 'worker', true), false);
  assert.equal(canUploadExecutionEvidence(report(), 'in_progress', 'worker', false), false);
});

test('client rejects unsupported, empty, oversized or unsafe files', () => {
  assert.equal(validateExecutionFile(acceptedFile), 'photo');
  assert.equal(validateExecutionFile({ ...acceptedFile, type: 'application/pdf', name: 'a.pdf' }), 'document');
  assert.throws(() => validateExecutionFile({ ...acceptedFile, size: 0 }), /2 MiB/);
  assert.throws(() => validateExecutionFile({ ...acceptedFile, size: MAX_EXECUTION_FILE_BYTES + 1 }), /2 MiB/);
  assert.throws(() => validateExecutionFile({ ...acceptedFile, type: 'text/html' }), /JPEG/);
  assert.throws(() => validateExecutionFile({ ...acceptedFile, name: '../unsafe.png' }), /nombre/);
});

test('upload must be confirmed by server report id and supported MIME', () => {
  const file = { id: 'id1', work_order_execution_id: 'x1', mime_type: 'image/png', kind: 'photo' };
  assert.deepEqual(validateExecutionEvidenceResponse({ data: file }, 'x1'), file);
  assert.throws(() => validateExecutionEvidenceResponse({ data: file }, 'x2'), /no se pudo confirmar/i);
  assert.throws(() => validateExecutionEvidenceResponse({ data: { ...file, kind: 'document' } }, 'x1'), /no se pudo confirmar/i);
  assert.throws(() => validateExecutionEvidenceResponse({ data: file }, 'x1', 'wrong'), /no se pudo confirmar/i);
});

test('execution private upload ACK must match report, actor and exact prepared bytes', () => {
  const reportId = 'e9a37f0c-30bd-42bc-ac4e-e22613240054';
  const actorId = 'a0e95ddf-24d8-43c9-b934-6d2974656936';
  const payload = { kind: 'photo', mime_type: 'image/jpeg',
    original_name: 'inspeccion.jpg', content_base64: '/9j/' };
  // The work-order API intentionally omits client_upload_id and digest
  // from its public receipt; do not manufacture them in the client.
  const asset = { id: '777a9aa2-fcca-49d3-8280-85e22aa55765',
    work_order_execution_id: reportId, uploaded_by: actorId,
    kind: 'photo', mime_type: 'image/jpeg',
    original_name: 'inspeccion.jpg', size_bytes: 3 };
  const expected = { actorId, payload };
  for (const replayed of [false, true]) {
    assert.equal(validateExecutionEvidenceResponse(
      { data: asset, replayed }, reportId, null, expected
    ).id, asset.id);
  }
  for (const mutation of [
    { id: '' }, { work_order_execution_id: 'wrong' },
    { uploaded_by: 'another' }, { original_name: 'unexpected.jpg' },
    { kind: 'document' }, { mime_type: 'image/png' },
    { size_bytes: 4 }, { size_bytes: '3' }
  ]) {
    assert.throws(() => validateExecutionEvidenceResponse({
      data: { ...asset, ...mutation }, replayed: false
    }, reportId, null, expected), /no se pudo confirmar/i);
  }
  for (const response of [null, { data: asset }, { data: asset, replayed: null }]) {
    assert.throws(() => validateExecutionEvidenceResponse(response, reportId, null, expected),
      /no se pudo confirmar/i);
  }
  assert.throws(() => validateExecutionEvidenceResponse({
    data: asset, replayed: true
  }, reportId, null, { ...expected, payload: { ...payload, content_base64: '' } }),
  /no se pudo confirmar/i);
});

test('private download refuses changed evidence id, mime or length', async () => {
  const bytes = Buffer.from('%PDF-1.4\n%%EOF\n');
  const response = { data: { id: 'id1', mime_type: 'application/pdf',
    size_bytes: bytes.length, content_base64: bytes.toString('base64') } };
  const blob = decodePrivateEvidenceResponse(response, 'id1', 'application/pdf');
  assert.equal(blob.size, bytes.length);
  assert.equal(blob.type, 'application/pdf');
  assert.throws(() => decodePrivateEvidenceResponse(response, 'id2', 'application/pdf'), /no coincide/);
  assert.throws(() => decodePrivateEvidenceResponse(response, 'id1', 'image/png'), /no coincide/);
  assert.throws(() => decodePrivateEvidenceResponse({ data: { ...response.data, size_bytes: 999 } },
    'id1', 'application/pdf'), /tamaño/);
});

test('UI is attached to real execution reports, preserves retry id and uses one metadata endpoint', () => {
  const jsx = readFileSync(new URL('../src/components/WorkOrderExecutionEvidence.jsx', import.meta.url), 'utf8');
  const panel = readFileSync(new URL('../src/components/WorkOrderExecutionPanel.jsx', import.meta.url), 'utf8');
  assert.match(jsx, /client_upload_id: uploadKey/);
  assert.match(jsx, /validateExecutionEvidenceResponse\\(response, report\\.id, null, /);
  assert.match(jsx, /uploadCache\.current\.prepare\(file, uploadKey\)/);
  assert.match(jsx, /uploadFence\.current\.isCurrent\(ticket\)/);
  assert.match(jsx, /const uploadInFlight = useRef\(null\)/);
  assert.match(jsx, /uploadFence\.current\.isCurrent\(uploadInFlight\.current\)/);
  assert.match(jsx, /uploadInFlight\.current === ticket/);
  assert.match(jsx, /viewFence\.current\.isCurrent\(ticket\)/);
  assert.match(jsx, /const identity = sessionScope\(session\)/);
  assert.doesNotMatch(jsx, /readAsDataURL\(file\)/);
  assert.match(jsx, /reintentar/i);
  assert.match(jsx, /execution-evidence/);
  assert.match(jsx, /\/integrity/);
  assert.match(jsx, /\/content/);
  assert.match(jsx, /URL\.revokeObjectURL/);
  assert.match(panel, /<WorkOrderExecutionEvidence order=\{order\} reports=\{reports\}/);
});
