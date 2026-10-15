// Browser-safe validation before offering a server-derived document download.
const MIME = Object.freeze({
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
});
export function decodeFieldDocument(payload, format) {
  if (!Object.hasOwn(MIME, format) || !payload ||
      payload.mimeType !== MIME[format] ||
      !Number.isSafeInteger(payload.size_bytes) || payload.size_bytes <= 0 ||
      payload.size_bytes > 3 * 1024 * 1024 ||
      typeof payload.content_base64 !== 'string' ||
      payload.content_base64.length > 4 * 1024 * 1024 + 4 ||
      !Number.isSafeInteger(payload.counts?.observations) ||
      !Number.isSafeInteger(payload.counts?.workOrders)) {
    throw new Error('Respuesta de reporte inválida; no se descargó ningún archivo.');
  }
  let binary;
  try { binary = atob(payload.content_base64); }
  catch { throw new Error('El reporte recibido no tiene una codificación válida.'); }
  if (binary.length !== payload.size_bytes) {
    throw new Error('El reporte recibido tiene un tamaño inesperado.');
  }
  if ((format === 'pdf' && !binary.startsWith('%PDF-')) ||
      (format === 'xlsx' && !binary.startsWith('PK\x03\x04'))) {
    throw new Error('El servidor devolvió un archivo con firma inválida.');
  }
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return { blob: new Blob([bytes], { type: MIME[format] }),
    counts: payload.counts };
}
