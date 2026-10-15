// Presentation contract for the authorized, bounded evidence-status query.
// Never materialize a BYTEA in HTTP responses or derive "present" from
// EvidenceAsset metadata alone. Presence is not a cryptographic hash check.
export const RUN_EVIDENCE_LIMIT = 100;

export function evidenceProvenanceView(rows, blobIds, runId) {
  const present = new Set(blobIds);
  return {
    run_id: runId,
    limit: RUN_EVIDENCE_LIMIT,
    has_more: rows.length > RUN_EVIDENCE_LIMIT,
    items: rows.slice(0, RUN_EVIDENCE_LIMIT).map(asset => ({
      id: asset.id,
      scouting_observation_id: asset.scouting_observation_id,
      uploaded_by: asset.uploaded_by,
      client_upload_id: asset.client_upload_id,
      kind: asset.kind,
      mime_type: asset.mime_type,
      size_bytes: asset.size_bytes,
      captured_at: asset.captured_at,
      bytes_available: present.has(asset.id)
    }))
  };
}
