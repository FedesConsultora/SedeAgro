import { createHash, timingSafeEqual } from 'node:crypto';
import { MAX_EVIDENCE_BYTES } from './evidenceContent.js';

const SHA256_HEX = /^[0-9a-f]{64}$/;
export const EVIDENCE_INTEGRITY_STATUSES = Object.freeze([
  'verified', 'mismatch', 'missing', 'unverifiable', 'oversize'
]);

// Pure, server-side result. Never return the digest, the expected hash,
// the byte array or any storage metadata in an HTTP response.
export function classifyEvidenceIntegrity({ expectedHash, declaredSize, blobLength, bytes }) {
  if (blobLength === null) return 'missing';
  if (!Number.isSafeInteger(blobLength) || blobLength < 0 || blobLength > MAX_EVIDENCE_BYTES) {
    return 'oversize';
  }
  if (!SHA256_HEX.test(expectedHash ?? '') ||
      !Number.isSafeInteger(declaredSize) || declaredSize < 1) {
    return 'unverifiable';
  }
  // The expected length is authoritative metadata to verify, NOT a reason
  // to skip a differing actual-size result or quietly endorse corrupted data.
  if (blobLength !== declaredSize) return 'mismatch';
  if (!Buffer.isBuffer(bytes) || bytes.length !== blobLength) return 'unverifiable';
  const computed = createHash('sha256').update(bytes).digest();
  return timingSafeEqual(computed, Buffer.from(expectedHash, 'hex')) ? 'verified' : 'mismatch';
}

export function shouldReadEvidenceBytes(expectedHash, declaredSize, blobLength) {
  return blobLength !== null && Number.isSafeInteger(blobLength) &&
    blobLength > 0 && blobLength <= MAX_EVIDENCE_BYTES &&
    blobLength === declaredSize && SHA256_HEX.test(expectedHash ?? '');
}
