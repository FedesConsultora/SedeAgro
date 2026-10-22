import {
  decodePrivateEvidenceResponse, EXECUTION_FILE_TYPES, MAX_EXECUTION_FILE_BYTES
} from './executionEvidence.js';

const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const PHOTO_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const error = () => new Error('La descarga privada no coincide con el archivo seleccionado.');

function safeName(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 180 &&
    !/[\\/\x00-\x1f\x7f]/.test(value) && value !== '.' && value !== '..';
}

// A server 200 only proves transport success. The persisted private bytes
// must also match the selected asset's immutable identity and byte length.
// The backend is responsible for SHA-256 verification before responding.
export function parseScoutingPrivateEvidence(response, selected) {
  const file = response?.data;
  if (!file || !selected || !UUID.test(String(selected.id)) ||
      !Object.hasOwn(EXECUTION_FILE_TYPES, selected.mime_type) ||
      !Number.isSafeInteger(selected.size_bytes) ||
      selected.size_bytes < 1 || selected.size_bytes > MAX_EXECUTION_FILE_BYTES ||
      !safeName(selected.original_name) ||
      file.id !== selected.id || file.mime_type !== selected.mime_type ||
      file.original_name !== selected.original_name ||
      file.size_bytes !== selected.size_bytes) {
    throw error();
  }
  try {
    const blob = decodePrivateEvidenceResponse(response, selected.id, selected.mime_type);
    if (blob.size !== selected.size_bytes) throw error();
    return { blob, filename: selected.original_name };
  } catch {
    // Keep private bytes, IDs and server internals out of exception messages.
    throw error();
  }
}

export function isScoutingPreviewable(selected) {
  return Boolean(selected && PHOTO_MIME.has(selected.mime_type));
}
