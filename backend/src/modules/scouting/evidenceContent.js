import { HttpError } from '../../utils/http.js';

export const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;
export const SUPPORTED_EVIDENCE_TYPES = Object.freeze({
  'image/jpeg': 'photo',
  'image/png': 'photo',
  'image/webp': 'photo',
  'application/pdf': 'document'
});

function looksLikeType(buffer, mimeType) {
  if (mimeType === 'image/jpeg') return buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mimeType === 'image/png') return buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  if (mimeType === 'image/webp') return buffer.length > 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  if (mimeType === 'application/pdf') return buffer.length > 5 && buffer.toString('ascii', 0, 5) === '%PDF-';
  return false;
}

export function decodeEvidenceContent({ kind, mime_type: mimeType, content_base64: encoded }) {
  if (!Object.hasOwn(SUPPORTED_EVIDENCE_TYPES, mimeType) || SUPPORTED_EVIDENCE_TYPES[mimeType] !== kind) {
    throw new HttpError(422, 'Solo se admiten fotografías JPEG/PNG/WebP y PDF con tipo correcto.', undefined, 'EVIDENCE_TYPE_INVALID');
  }
  if (typeof encoded !== 'string' || !encoded || encoded.length > Math.ceil(MAX_EVIDENCE_BYTES / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new HttpError(422, 'El archivo no tiene formato base64 válido o supera los 2 MiB.', undefined, 'EVIDENCE_CONTENT_INVALID');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > MAX_EVIDENCE_BYTES || bytes.toString('base64') !== encoded || !looksLikeType(bytes, mimeType)) {
    throw new HttpError(422, 'El contenido no coincide con el formato informado o supera los 2 MiB.', undefined, 'EVIDENCE_CONTENT_INVALID');
  }
  return bytes;
}

export function safeEvidenceFileName(name) {
  if (typeof name !== 'string' || name.length < 1 || name.length > 180 || /[\\/\x00-\x1f\x7f]/.test(name) ||
      name === '.' || name === '..') {
    throw new HttpError(422, 'Nombre de archivo inválido.', undefined, 'EVIDENCE_NAME_INVALID');
  }
  return name;
}
