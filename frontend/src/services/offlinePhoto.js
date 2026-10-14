// A single bounded photo may travel alongside an encrypted offline observation
// draft. The photo is NOT included in the batch JSON sent to /sync/batches.
export const MAX_OFFLINE_PHOTO_BYTES = 512 * 1024;
export const OFFLINE_PHOTO_MIME_TYPES = Object.freeze([
  'image/jpeg', 'image/png', 'image/webp'
]);

export function validateOfflinePhoto(photo) {
  if (!photo || typeof photo !== 'object') throw new Error('No se encontró la fotografía.');
  if (!OFFLINE_PHOTO_MIME_TYPES.includes(photo.mime_type)) {
    throw new Error('La foto debe ser JPEG, PNG o WebP.');
  }
  if (typeof photo.original_name !== 'string' || !photo.original_name ||
      photo.original_name.length > 180 || /[\\/\x00-\x1f\x7f]/.test(photo.original_name)) {
    throw new Error('Nombre de fotografía inválido.');
  }
  if (typeof photo.content_base64 !== 'string' ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(photo.content_base64)) {
    throw new Error('Contenido de fotografía inválido.');
  }
  const length = photo.content_base64.length;
  const size = length * 3 / 4 -
    (photo.content_base64.endsWith('==') ? 2 : photo.content_base64.endsWith('=') ? 1 : 0);
  if (!Number.isInteger(size) || size < 1 || size > MAX_OFFLINE_PHOTO_BYTES) {
    throw new Error('La foto offline debe pesar entre 1 byte y 512 KiB.');
  }
  // Do not queue a file whose declared format will be rejected later by the
  // backend. This is only a header check, not full image decoding/antivirus.
  const header = atob(photo.content_base64.slice(0, 32));
  const bytes = [...header].map((character) => character.charCodeAt(0));
  const jpeg = photo.mime_type === 'image/jpeg' &&
    bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = photo.mime_type === 'image/png' &&
    [137,80,78,71,13,10,26,10].every((value, index) => bytes[index] === value);
  const webp = photo.mime_type === 'image/webp' &&
    header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP';
  if (!jpeg && !png && !webp) {
    throw new Error('El contenido de la fotografía no coincide con su formato.');
  }
  return { ...photo, size_bytes: size };
}

export async function readOfflinePhoto(file) {
  if (!file) return null;
  if (!OFFLINE_PHOTO_MIME_TYPES.includes(file.type) ||
      !file.size || file.size > MAX_OFFLINE_PHOTO_BYTES) {
    throw new Error('Elegí una foto JPEG, PNG o WebP de hasta 512 KiB.');
  }
  const encoded = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('No se pudo leer la fotografía local.'));
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.readAsDataURL(file);
  });
  const validated = validateOfflinePhoto({
    original_name: file.name, mime_type: file.type, content_base64: encoded
  });
  if (validated.size_bytes !== file.size) {
    throw new Error('El archivo cambió mientras se preparaba la carga.');
  }
  return validated;
}
