import { validateExecutionFile } from './executionEvidence.js';
import {
  cameraPhotoPlan, MAX_OFFLINE_PHOTO_BYTES, OFFLINE_PHOTO_MIME_TYPES, readOfflinePhoto
} from './offlinePhoto.js';

// PDFs intentionally preserve their original bytes. Photos never do: the
// existing field-photo pipeline decodes pixels, strips source metadata and
// re-encodes a bounded JPEG before it can reach either online upload route.
function readDocumentBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('No se pudo leer el documento.'));
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.readAsDataURL(file);
  });
}

export async function preparePrivateEvidenceUpload(file, {
  sanitizePhoto = readOfflinePhoto,
  readDocument = readDocumentBase64
} = {}) {
  // A typical phone photo can exceed the 2 MiB *upload* limit before Canvas
  // removes metadata and reduces it. The shared offline camera preflight
  // allows up to 12 MiB of SOURCE bytes without ever sending those bytes.
  // Documents do not undergo conversion, so they keep the 2 MiB input limit.
  const isPhoto = OFFLINE_PHOTO_MIME_TYPES.includes(file?.type);
  const kind = isPhoto ? 'photo' : validateExecutionFile(file);
  if (isPhoto) {
    cameraPhotoPlan(file);
    // Preserve the original evidence validator's dot-name rejection.
    if (file.name === '.' || file.name === '..') {
      throw new Error('El nombre del archivo no es válido.');
    }
  }
  if (kind === 'document') {
    const content_base64 = await readDocument(file);
    if (!content_base64) throw new Error('No se pudo leer el documento.');
    return { kind, mime_type: file.type, original_name: file.name, content_base64 };
  }

  // Fail closed: a decoder error must never fall back to the source image.
  const converted = await sanitizePhoto(file);
  if (converted?.sanitized !== true || converted?.mime_type !== 'image/jpeg' ||
      !converted?.original_name || !converted?.content_base64 ||
      !Number.isInteger(converted.size_bytes) || converted.size_bytes < 1 ||
      converted.size_bytes > MAX_OFFLINE_PHOTO_BYTES) {
    throw new Error('No se pudo preparar una fotografía JPEG sin metadatos.');
  }
  return {
    kind: 'photo',
    mime_type: 'image/jpeg',
    original_name: converted.original_name,
    content_base64: converted.content_base64
  };
}

// A failed/ambiguous HTTP acknowledgement must not trigger a second Canvas
// encoding under the same idempotency UUID. Reuse identical prepared bytes.
export function createPrivateUploadCache() {
  let cached = null;
  return Object.freeze({
    async prepare(file, key, prepare = preparePrivateEvidenceUpload) {
      if (!key || !file) throw new Error('Seleccioná un archivo nuevo antes de adjuntar.');
      if (cached?.key === key && cached?.file === file) return cached.payload;
      const payload = await prepare(file);
      cached = { key, file, payload };
      return payload;
    },
    reset() { cached = null; }
  });
}
