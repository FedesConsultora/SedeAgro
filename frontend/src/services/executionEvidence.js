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

export function validateExecutionEvidenceResponse(response, reportId, existingId = null) {
  const asset = response?.data;
  if (!asset || asset.work_order_execution_id !== reportId ||
      typeof asset.id !== 'string' || (existingId && asset.id !== existingId) ||
      !Object.hasOwn(EXECUTION_FILE_TYPES, asset.mime_type) ||
      asset.kind !== EXECUTION_FILE_TYPES[asset.mime_type]) {
    throw new Error('No se pudo confirmar el adjunto mediante el servidor.');
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
