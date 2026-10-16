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
  assert.match(jsx, /reintentar/i);
  assert.match(jsx, /execution-evidence/);
  assert.match(jsx, /\/integrity/);
  assert.match(jsx, /\/content/);
  assert.match(jsx, /URL\.revokeObjectURL/);
  assert.match(panel, /<WorkOrderExecutionEvidence order=\{order\} reports=\{reports\}/);
});
