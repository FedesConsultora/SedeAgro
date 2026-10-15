const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const STATUSES = new Set(['verified', 'mismatch', 'missing', 'unverifiable', 'oversize']);

// Do not trust an unscoped/partial response as a verified checksum.
// Only a single explicitly selected server evidence ID can receive a result.
export function parseEvidenceIntegrity(reply, expectedEvidenceId) {
  if (!UUID.test(String(expectedEvidenceId)) ||
      reply?.data?.id !== expectedEvidenceId ||
      !STATUSES.has(reply?.data?.status)) {
    throw new Error('El servidor no confirmó una verificación de integridad válida.');
  }
  return reply.data.status;
}

export const EVIDENCE_INTEGRITY_STATUS = Object.freeze({
  verified: {
    label: 'Integridad SHA-256 verificada',
    detail: 'Bytes, tamaño y SHA-256 coinciden con los valores registrados por el servidor.'
  },
  mismatch: {
    label: 'Contenido o tamaño no coincide',
    detail: 'El archivo no coincide con los metadatos registrados. Requiere intervención.'
  },
  missing: {
    label: 'Archivo ausente',
    detail: 'Existe la referencia de evidencia, pero no se encontró su blob privado.'
  },
  unverifiable: {
    label: 'Integridad no verificable',
    detail: 'Falta un hash/tamaño válido o la lectura cambió durante la consulta; no hay prueba de integridad.'
  },
  oversize: {
    label: 'Archivo fuera del límite',
    detail: 'El tamaño almacenado impide la comprobación acotada de hasta 2 MiB.'
  }
});
