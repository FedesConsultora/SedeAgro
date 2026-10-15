import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { classifyEvidenceIntegrity, shouldReadEvidenceBytes,
  EVIDENCE_INTEGRITY_STATUSES } from '../src/modules/scouting/evidenceIntegrity.js';
import { MAX_EVIDENCE_BYTES } from '../src/modules/scouting/evidenceContent.js';

const bytes = Buffer.from('private-image-data');
const hash = createHash('sha256').update(bytes).digest('hex');
const source = { expectedHash: hash, declaredSize: bytes.length, blobLength: bytes.length, bytes };

test('SHA-256 integrity requires exact source bytes and declared length', () => {
  assert.equal(classifyEvidenceIntegrity(source), 'verified');
  assert.equal(classifyEvidenceIntegrity({ ...source, bytes: Buffer.from('private-image-datb') }), 'mismatch');
  assert.equal(classifyEvidenceIntegrity({ ...source, expectedHash: '0'.repeat(64) }), 'mismatch');
  assert.equal(classifyEvidenceIntegrity({ ...source, blobLength: bytes.length - 1 }), 'mismatch');
  assert.equal(classifyEvidenceIntegrity({ ...source, declaredSize: bytes.length - 1 }), 'mismatch');
  assert.equal(classifyEvidenceIntegrity({ ...source, bytes: null }), 'unverifiable');
});

test('legacy hashes, malformed digest and sizes cannot be falsely declared valid', () => {
  for (const digest of [null, undefined, '', 'A'.repeat(64), 'z'.repeat(64), '0'.repeat(63)]) {
    assert.equal(classifyEvidenceIntegrity({ ...source, expectedHash: digest }), 'unverifiable');
    assert.equal(shouldReadEvidenceBytes(digest, bytes.length, bytes.length), false);
  }
  for (const size of [null, 0, -1, 2.1, NaN]) {
    assert.equal(shouldReadEvidenceBytes(hash, size, bytes.length), false);
    assert.equal(classifyEvidenceIntegrity({ ...source, declaredSize: size }), 'unverifiable');
  }
  assert.equal(classifyEvidenceIntegrity({ ...source, blobLength: null, bytes: undefined }), 'missing');
});

test('out-of-range stored bytes cannot be transferred to server hash computation', () => {
  assert.equal(MAX_EVIDENCE_BYTES, 2 * 1024 * 1024);
  assert.equal(classifyEvidenceIntegrity({
    ...source, blobLength: MAX_EVIDENCE_BYTES + 1, bytes: undefined
  }), 'oversize');
  assert.equal(shouldReadEvidenceBytes(hash, MAX_EVIDENCE_BYTES + 1,
    MAX_EVIDENCE_BYTES + 1), false);
  assert.equal(shouldReadEvidenceBytes(hash, bytes.length, bytes.length), true);
  assert.deepEqual(EVIDENCE_INTEGRITY_STATUSES,
    ['verified', 'mismatch', 'missing', 'unverifiable', 'oversize']);
});

test('returned status is an enum and never an object containing bytes or the SHA-256 hash', () => {
  for (const state of [
    classifyEvidenceIntegrity(source),
    classifyEvidenceIntegrity({ ...source, blobLength: null }),
    classifyEvidenceIntegrity({ ...source, expectedHash: null }),
    classifyEvidenceIntegrity({ ...source, bytes: Buffer.from('private-image-datb') })
  ]) {
    assert.equal(typeof state, 'string');
    assert.ok(EVIDENCE_INTEGRITY_STATUSES.includes(state));
    assert.equal(state.includes(hash), false);
    assert.equal(state.includes('private-image'), false);
  }
});
