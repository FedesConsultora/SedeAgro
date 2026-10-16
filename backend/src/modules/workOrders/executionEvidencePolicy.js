// Order-linked files reuse the existing private evidence storage and decoder.
// An uploaded file is a submitted attachment, NOT automatic field verification.
export const EXECUTION_EVIDENCE_LIMIT = 8;
export const ORDER_EVIDENCE_LIMIT = 20 * EXECUTION_EVIDENCE_LIMIT;

export function canAttachExecutionEvidence({ orderStatus, reviewStatus, uploaderId, submitterId, count }) {
  return orderStatus === 'in_progress' && reviewStatus === 'submitted' &&
    Boolean(uploaderId && submitterId && uploaderId === submitterId) &&
    Number.isInteger(count) && count >= 0 && count < EXECUTION_EVIDENCE_LIMIT;
}

export function sameExecutionUpload(asset, { orderId, executionId, digest, kind, mimeType, originalName }) {
  return asset?.work_order_id === orderId &&
    asset.work_order_execution_id === executionId &&
    asset.content_sha256 === digest &&
    asset.kind === kind && asset.mime_type === mimeType &&
    asset.original_name === originalName;
}

export function visibleExecutionEvidence(asset) {
  return {
    id: asset.id,
    work_order_execution_id: asset.work_order_execution_id,
    original_name: asset.original_name,
    kind: asset.kind,
    mime_type: asset.mime_type,
    size_bytes: asset.size_bytes,
    uploaded_by: asset.uploaded_by,
    created_at: asset.created_at,
    // Deliberately no blob bytes, hashes, private storage keys or optional GPS.
  };
}
