// Verify authenticated persisted bytes in the browser before exposing a Blob.
const MIME = Object.freeze({
  pdf: 'application/pdf', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv;charset=utf-8'
});
export async function decodeAsyncReportFile(file) {
  const format = file?.filename?.split('.').pop();
  if (!Object.hasOwn(MIME, format) || file.mimeType !== MIME[format] ||
      !Number.isSafeInteger(file.size_bytes) || file.size_bytes < 1 ||
      file.size_bytes > 3145728 || !/^[a-f0-9]{64}$/.test(file.sha256 || '') ||
      typeof file.content_base64 !== 'string') {
    throw new Error('El reporte recibido contiene metadatos inválidos.');
  }
  const base64 = file.content_base64.replace(/\s/g, '');
  if (base64.length > 4194304 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(base64)) {
    throw new Error('El reporte recibido no es un archivo Base64 válido.');
  }
  let decoded;
  try { decoded = atob(base64); }
  catch { throw new Error('La descarga de reporte está dañada.'); }
  const bytes = Uint8Array.from(decoded, c => c.charCodeAt(0));
  if (bytes.length !== file.size_bytes ||
      (format === 'pdf' && !decoded.startsWith('%PDF-')) ||
      (format === 'xlsx' && !decoded.startsWith('PK\x03\x04')) ||
      (format === 'csv' && !decoded.startsWith('\xEF\xBB\xBF'))) {
    throw new Error('El reporte descargado no coincide con su tamaño o formato.');
  }
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
  if (hex !== file.sha256) throw new Error('Error de integridad SHA-256 del reporte.');
  return { blob: new Blob([bytes], { type: MIME[format] }), filename: file.filename };
}
