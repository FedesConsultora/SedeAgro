// Offline field photos are bounded before entering encrypted IndexedDB.
// Canvas re-encoding strips embedded EXIF/GPS metadata on compressed files.
// Small originals retain their bytes, so users must be explicitly warned that
// their source metadata may remain in unmodified JPEG/WebP photographs.
export const MAX_OFFLINE_PHOTO_BYTES = 512 * 1024;
export const MAX_CAMERA_SOURCE_BYTES = 12 * 1024 * 1024;
export const MAX_CAMERA_PIXELS = 40_000_000;
export const OFFLINE_PHOTO_MIME_TYPES = Object.freeze([
  'image/jpeg', 'image/png', 'image/webp'
]);
const SIZES = Object.freeze([2048, 1600, 1280, 1024, 800, 640]);
const QUALITIES = Object.freeze([0.82, 0.7, 0.58, 0.46]);

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
  // This is a signature check, not full image decoding, malware scanning or
  // exhaustive format validation (the backend validates again).
  const header = atob(photo.content_base64.slice(0, 32));
  const bytes = [...header].map((character) => character.charCodeAt(0));
  const jpeg = photo.mime_type === 'image/jpeg' &&
    bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = photo.mime_type === 'image/png' &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
  const webp = photo.mime_type === 'image/webp' &&
    header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP';
  if (!jpeg && !png && !webp) {
    throw new Error('El contenido de la fotografía no coincide con su formato.');
  }
  return { ...photo, size_bytes: size };
}

export function cameraPhotoPlan(file) {
  if (!file || !OFFLINE_PHOTO_MIME_TYPES.includes(file.type) ||
      !Number.isInteger(file.size) || file.size < 1 ||
      file.size > MAX_CAMERA_SOURCE_BYTES) {
    throw new Error('Elegí una foto JPEG, PNG o WebP de hasta 12 MiB.');
  }
  if (typeof file.name !== 'string' || !file.name ||
      file.name.length > 180 || /[\\/\x00-\x1f\x7f]/.test(file.name)) {
    throw new Error('El nombre de la fotografía contiene caracteres inválidos.');
  }
  return { compress: file.size > MAX_OFFLINE_PHOTO_BYTES, sourceBytes: file.size };
}

export function photoOutputName(sourceName) {
  const stem = sourceName.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]/g, '-')
    .replace(/-+/g, '-').slice(0, 160) || 'campo';
  return `${stem}-reducida.jpg`;
}

export function scaledPhotoSize(width, height, longestSide) {
  if (!Number.isFinite(width) || !Number.isFinite(height) ||
      width < 1 || height < 1 || width * height > MAX_CAMERA_PIXELS) {
    throw new Error('La resolución de la cámara excede el límite de 40 megapíxeles.');
  }
  const ratio = Math.min(1, longestSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)) };
}

async function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('No se pudo leer la fotografía local.'));
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.readAsDataURL(blob);
  });
}

async function encodeJpeg(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((result) => {
      if (!result || result.type !== 'image/jpeg') {
        reject(new Error('El navegador no pudo codificar la fotografía JPEG.'));
      } else {
        resolve(result);
      }
    }, 'image/jpeg', quality);
  });
}

export async function readOfflinePhoto(file) {
  if (!file) return null;
  const plan = cameraPhotoPlan(file);
  let output = file;
  let converted = false;

  if (plan.compress) {
    if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') {
      throw new Error('Este navegador no admite reducir fotos grandes. Elegí una de hasta 512 KiB.');
    }
    let image;
    try {
      image = await createImageBitmap(file, { imageOrientation: 'from-image' });
      if (!image?.width || !image?.height) throw new Error('No se pudo decodificar la fotografía.');
      scaledPhotoSize(image.width, image.height, SIZES[0]);
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('El navegador no permite preparar fotografías.');
      let found = false;
      for (const longestSide of SIZES) {
        const size = scaledPhotoSize(image.width, image.height, longestSide);
        canvas.width = size.width;
        canvas.height = size.height;
        // Assigning canvas dimensions resets the 2D state. Set smoothing and
        // a white matte each iteration to avoid black transparent PNG regions.
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.fillStyle = '#fff';
        context.fillRect(0, 0, size.width, size.height);
        context.drawImage(image, 0, 0, size.width, size.height);
        for (const quality of QUALITIES) {
          const candidate = await encodeJpeg(canvas, quality);
          if (candidate.size > 0 && candidate.size <= MAX_OFFLINE_PHOTO_BYTES) {
            output = candidate;
            converted = true;
            found = true;
            break;
          }
        }
        if (found) break;
      }
      canvas.width = 0;
      canvas.height = 0;
      if (!found) {
        throw new Error('No fue posible reducir la foto a 512 KiB sin perder demasiada resolución.');
      }
    } catch (error) {
      if (error?.name === 'InvalidStateError' || error?.name === 'EncodingError') {
        throw new Error('No se pudo abrir la imagen. Probá otra fotografía.');
      }
      throw error;
    } finally {
      image?.close?.();
    }
  }

  const encoded = await toBase64(output);
  const validated = validateOfflinePhoto({
    original_name: converted ? photoOutputName(file.name) : file.name,
    mime_type: converted ? 'image/jpeg' : file.type,
    content_base64: encoded
  });
  if (validated.size_bytes !== output.size) {
    throw new Error('El archivo cambió mientras se preparaba la carga.');
  }
  return {
    ...validated,
    source_bytes: file.size,
    resized: converted
  };
}
