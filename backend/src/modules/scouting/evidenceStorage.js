import { EvidenceBlob } from '../../models/index.js';

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
