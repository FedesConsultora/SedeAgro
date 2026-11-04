// Browser-safe validation before offering a server-derived field document.
// A successful HTTP response alone cannot identify the field or certify counts.
const MIME = Object.freeze({
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ROWS_PER_TYPE = 200;
const COUNT_KEYS = ['observations', 'workOrders', 'executions'];

export function checkedFieldExportCounts(counts) {
  if (!counts || typeof counts !== 'object' || Array.isArray(counts) ||
      Object.keys(counts).sort().join('|') !== COUNT_KEYS.slice().sort().join('|') ||
      COUNT_KEYS.some(key => !Number.isSafeInteger(counts[key]) ||
        counts[key] < 0 || counts[key] > MAX_ROWS_PER_TYPE)) {
    throw new Error('Respuesta de reporte inválida; no se descargó ningún archivo.');
  }
  return counts;
}

export function checkedFieldExportFilename(filename, fieldId, format) {
  if (!UUID.test(fieldId || '') || !['csv', 'pdf', 'xlsx'].includes(format) ||
      filename !== `reporte-lote-${fieldId}.${format}`) {
    throw new Error('El servidor no confirmó un archivo del lote solicitado.');
  }
  return filename;
}

export function decodeFieldCsv(payload, fieldId) {
  checkedFieldExportFilename(payload?.filename, fieldId, 'csv');
  const counts = checkedFieldExportCounts(payload?.counts);
  if (payload.mimeType !== 'text/csv;charset=utf-8' ||
      typeof payload.csv !== 'string' || !payload.csv.startsWith('\uFEFF') ||
      payload.csv.length < 2 || payload.csv.length > 1024 * 1024 ||
      new TextEncoder().encode(payload.csv).byteLength > 1024 * 1024) {
    throw new Error('El servidor devolvió un CSV inválido. No se descargó ningún archivo.');
  }
  return { blob: new Blob([payload.csv], { type: payload.mimeType }), counts };
}

export function decodeFieldDocument(payload, format, fieldId) {
  checkedFieldExportFilename(payload?.filename, fieldId, format);
  if (!Object.hasOwn(MIME, format) || !payload ||
      payload.mimeType !== MIME[format] ||
      !Number.isSafeInteger(payload.size_bytes) || payload.size_bytes <= 0 ||
      payload.size_bytes > 3 * 1024 * 1024 ||
      typeof payload.content_base64 !== 'string' ||
      payload.content_base64.length > 4 * 1024 * 1024 + 4) {
    throw new Error('Respuesta de reporte inválida; no se descargó ningún archivo.');
  }
  const counts = checkedFieldExportCounts(payload.counts);
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
  return { blob: new Blob([bytes], { type: MIME[format] }), counts };
}
