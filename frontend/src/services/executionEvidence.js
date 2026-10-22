export const EXECUTION_FILE_TYPES = Object.freeze({
  'image/jpeg': 'photo',
  'image/png': 'photo',
  'image/webp': 'photo',
  'application/pdf': 'document'
});
export const MAX_EXECUTION_FILE_BYTES = 2 * 1024 * 1024;

export function canUploadExecutionEvidence(report, orderStatus, userId, live) {
  return Boolean(live && orderStatus === 'in_progress' && report?.review_status === 'submitted' &&
    userId && userId === report.submitted_by);
}

export function validateExecutionFile(file) {
  if (!file || !Object.hasOwn(EXECUTION_FILE_TYPES, file.type)) {
    throw new Error('Elegí una foto JPEG/PNG/WebP o un PDF.');
  }
  if (!Number.isInteger(file.size) || file.size < 1 || file.size > MAX_EXECUTION_FILE_BYTES) {
    throw new Error('El archivo debe tener contenido y pesar como máximo 2 MiB.');
  }
  if (typeof file.name !== 'string' || file.name.length < 1 || file.name.length > 180 ||
      /[\\/\x00-\x1f\x7f]/.test(file.name) || file.name === '.' || file.name === '..') {
    throw new Error('El nombre del archivo no es válido.');
  }
  return EXECUTION_FILE_TYPES[file.type];
}

// Count canonical Base64 bytes without allocating another sensitive 2 MiB blob.
// The backend uses the same grammar and rejects noncanonical bytes on POST.
export function preparedEvidenceByteLength(payload) {
  const encoded = payload?.content_base64;
  if (typeof encoded !== 'string' || !encoded || encoded.length > 2_796_204 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error('El archivo adjunto no tiene contenido Base64 verificable.');
  }
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  const bytes = (encoded.length / 4) * 3 - padding;
  if (!Number.isInteger(bytes) || bytes < 1 || bytes > MAX_EXECUTION_FILE_BYTES) {
    throw new Error('El tamaño de la evidencia privada no es válido.');
  }
  return bytes;
}

export function validateExecutionEvidenceResponse(response, reportId, existingId = null, expected = null) {
  const asset = response?.data;
  if (!asset || asset.work_order_execution_id !== reportId ||
      typeof asset.id !== 'string' || (existingId && asset.id !== existingId) ||
      !Object.hasOwn(EXECUTION_FILE_TYPES, asset.mime_type) ||
      asset.kind !== EXECUTION_FILE_TYPES[asset.mime_type]) {
    throw new Error('No se pudo confirmar el adjunto mediante el servidor.');
  }
  // The execution response intentionally excludes client_upload_id and SHA-256.
  // Compare only the fields the server really returns; never invent a receipt.
  if (expected) {
    let bytes;
    try { bytes = preparedEvidenceByteLength(expected.payload); } catch { /* invalid ACK */ }
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(asset.id) ||
        !expected.actorId || !bytes ||
        asset.uploaded_by !== expected.actorId ||
        asset.original_name !== expected.payload?.original_name ||
        asset.kind !== expected.payload?.kind ||
        asset.mime_type !== expected.payload?.mime_type ||
        asset.size_bytes !== bytes ||
        typeof response.replayed !== 'boolean') {
      throw new Error('No se pudo confirmar el adjunto mediante el servidor.');
    }
  }
  return asset;
}

export function decodePrivateEvidenceResponse(response, expectedId, expectedMime) {
  const file = response?.data;
  if (!file || file.id !== expectedId || file.mime_type !== expectedMime ||
      !Object.hasOwn(EXECUTION_FILE_TYPES, file.mime_type) ||
      typeof file.content_base64 !== 'string' || file.content_base64.length > 2796204 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content_base64)) {
    throw new Error('La descarga privada no coincide con el adjunto seleccionado.');
  }
  const binary = atob(file.content_base64);
  if (!binary.length || binary.length > MAX_EXECUTION_FILE_BYTES ||
      binary.length !== file.size_bytes) {
    throw new Error('La descarga privada tiene un tamaño incorrecto.');
  }
  return new Blob([Uint8Array.from(binary, char => char.charCodeAt(0))], { type: file.mime_type });
}
