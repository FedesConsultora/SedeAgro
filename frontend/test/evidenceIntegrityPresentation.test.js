import test from 'node:test';
import assert from 'node:assert/strict';
import { EVIDENCE_INTEGRITY_STATUS, parseEvidenceIntegrity
} from '../src/services/evidenceIntegrityPresentation.js';

const ASSET = 'a91e39b1-f267-41eb-9d93-d28ee9b2e812';
const OTHER = 'aa9b7628-45ea-412f-871c-8ec3bd8b20f6';

test('only exact selected evidence ID and known integrity status can be trusted', () => {
  for (const status of ['verified', 'mismatch', 'missing', 'unverifiable', 'oversize']) {
    assert.equal(parseEvidenceIntegrity({ data: { id: ASSET, status } }, ASSET), status);
    assert.ok(EVIDENCE_INTEGRITY_STATUS[status]?.label);
    assert.ok(EVIDENCE_INTEGRITY_STATUS[status]?.detail);
  }
  for (const response of [
    null, undefined, {}, { data: null }, { data: {} },
    { data: { id: OTHER, status: 'verified' } },
    { data: { id: ASSET, status: 'processed' } },
    { data: { id: ASSET, status: true } },
    { data: { id: ASSET, status: 'hash_matched' } }
  ]) assert.throws(() => parseEvidenceIntegrity(response, ASSET), /verificación/);
  assert.throws(() => parseEvidenceIntegrity({ data: { id: ASSET, status: 'verified' } }, OTHER));
  assert.throws(() => parseEvidenceIntegrity({ data: { id: ASSET, status: 'verified' } }, 'not uuid'));
});

test('verified requires checksum match, not just blob presence', () => {
  assert.match(EVIDENCE_INTEGRITY_STATUS.verified.detail, /SHA-256/);
  assert.match(EVIDENCE_INTEGRITY_STATUS.unverifiable.detail, /no hay prueba/);
  assert.match(EVIDENCE_INTEGRITY_STATUS.oversize.detail, /2 MiB/);
  assert.match(EVIDENCE_INTEGRITY_STATUS.missing.detail, /no se encontró/);
});
