import { reconcileOfflineDraft } from './offlineReconciliation.js';
import { validateOfflinePhoto } from './offlinePhoto.js';

const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const validUuid = value => typeof value === 'string' && UUID.test(value);

// A sync batch receipt can prove an observation exists, NEVER that its photo
// was delivered. This plan needs the original immutable encrypted photo draft.
export function planConfirmedPhotoRecovery(draft, receipt, session) {
  const matched = reconcileOfflineDraft(draft, [receipt], session);
  if (matched.status !== 'photo_pending') {
    throw new Error('La observación y el archivo no tienen una confirmación verificable.');
  }
  const evidence = draft.evidence;
  if (!evidence || evidence.kind !== 'photo' || !validUuid(evidence.client_upload_id)) {
    throw new Error('No hay un identificador de fotografía recuperable.');
  }
  const safePhoto = validateOfflinePhoto(evidence);
  return {
    observationId: matched.observationId,
    clientUploadId: evidence.client_upload_id,
    submittedBy: session.user.id,
    sizeBytes: safePhoto.size_bytes,
    mimeType: safePhoto.mime_type,
    originalName: safePhoto.original_name
  };
}

// The backend returns EvidenceAsset metadata on either 201 or idempotent 200.
// Requiring ALL bindings avoids mistaking a partial/stale answer for upload ACK.
export function verifiedPhotoUpload(reply, plan) {
  const asset = reply?.data;
  if (!validUuid(asset?.id) ||
      asset.client_upload_id !== plan?.clientUploadId ||
      asset.scouting_observation_id !== plan?.observationId ||
      asset.uploaded_by !== plan?.submittedBy ||
      asset.kind !== 'photo' ||
      asset.mime_type !== plan?.mimeType ||
      asset.original_name !== plan?.originalName ||
      asset.size_bytes !== plan?.sizeBytes) {
    throw new Error('La respuesta del servidor no confirmó la fotografía exacta. Conservamos la copia local.');
  }
  return { evidenceId: asset.id, replayed: reply.replayed === true };
}
