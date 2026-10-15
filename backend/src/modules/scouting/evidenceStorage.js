import { EvidenceBlob } from '../../models/index.js';
import { Op, col, fn, where } from 'sequelize';
import { MAX_EVIDENCE_BYTES } from './evidenceContent.js';

// Thin storage boundary: HTTP endpoints never access the bytea table directly.
// A future object-storage implementation can replace this adapter while
// preserving the private, tenant-scoped content contract and transactional metadata.
export async function putPrivateEvidence({ tenantId, evidenceId, bytes, transaction }) {
  await EvidenceBlob.create({
    tenant_id: tenantId,
    evidence_id: evidenceId,
    content: bytes
  }, { transaction });
  return `db:${evidenceId}`;
}

export async function getPrivateEvidence({ tenantId, evidenceId, transaction }) {
  const blob = await EvidenceBlob.findOne({
    where: { tenant_id: tenantId, evidence_id: evidenceId },
    attributes: ['content'],
    transaction
  });
  return blob ? Buffer.from(blob.content) : null;
}

// The integrity endpoint needs an inexpensive size probe first, not the
// BYTEA. PostgreSQL octet_length computes the size without transferring the
// content to Node. No change to the existing download path.
export async function getPrivateEvidenceByteLength({ tenantId, evidenceId, transaction }) {
  const blob = await EvidenceBlob.findOne({
    where: { tenant_id: tenantId, evidence_id: evidenceId },
    attributes: [[fn('octet_length', col('content')), 'byte_length']],
    transaction
  });
  if (!blob) return null;
  const length = Number(blob.get('byte_length'));
  return Number.isSafeInteger(length) && length >= 0 ? length : NaN;
}

// Bound the SECOND SELECT at the database predicate as defense against
// a bytea changing between the size probe and this read. A missing result
// must never be treated as proof of successful integrity.
export async function getBoundedPrivateEvidence({ tenantId, evidenceId, transaction }) {
  const blob = await EvidenceBlob.findOne({
    where: {
      tenant_id: tenantId,
      evidence_id: evidenceId,
      [Op.and]: where(fn('octet_length', col('content')), {
        [Op.lte]: MAX_EVIDENCE_BYTES
      })
    },
    attributes: ['content'],
    transaction
  });
  return blob ? Buffer.from(blob.content) : null;
}
