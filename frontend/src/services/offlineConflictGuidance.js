// Human-readable guidance must not guess whether PostgreSQL accepted an
// observation. Only syncedObservationId / server receipts establish that fact.
const byCode = Object.freeze({
  SCOUTING_RUN_NOT_FOUND: 'La recorrida ya no está disponible para tu cuenta. Consultá con el coordinador.',
  SCOUTING_RUN_CLOSED: 'La recorrida ya está cerrada. Pedí al coordinador cómo registrar la evidencia pendiente.',
  SYNC_RUN_NOT_FOUND: 'La recorrida fue eliminada o ya no está asignada a tu usuario.',
  SYNC_FIELD_NOT_FOUND: 'El lote o la campaña asociada ya no están disponibles.',
  SYNC_IDEMPOTENCY_CONFLICT: 'La clave de envío se usó con otro contenido. No modifiques este borrador; consultá soporte.',
  EVIDENCE_UPLOAD_CONFLICT: 'El identificador de la fotografía corresponde a otro archivo. Conservala y consultá soporte.'
});

export function guidanceForDraft(draft) {
  const isPhotoPending = Boolean(draft?.evidence && draft?.syncedObservationId);
  const phase = isPhotoPending ? 'photo' : 'observation';
  const status = draft?.state || 'pending';
  const hasError = Boolean(draft?.lastError);
  const heading = isPhotoPending
    ? 'Observación confirmada · fotografía pendiente'
    : 'Observación pendiente de confirmación';
  const defaultNext = isPhotoPending
    ? 'La observación está en el servidor. Solo falta confirmar el adjunto; no elimines el archivo local sin comprobarlo.'
    : 'Este borrador todavía no tiene una confirmación completa del servidor.';

  if (status === 'auth') {
    return {
      phase, heading,
      description: 'La sesión perdió autorización. Iniciá sesión con la misma cuenta y empresa antes de reintentar.',
      action: 'Volver a iniciar sesión y reintentar',
      tone: 'warning',
      canRetry: true
    };
  }
  if (status === 'conflict') {
    return {
      phase, heading,
      description: byCode[draft.errorCode] ||
        (phase === 'photo'
          ? 'No se pudo adjuntar la foto. La observación quedó registrada; verificá los permisos y el estado de la recorrida.'
          : 'El servidor rechazó este envío. Confirmá que seguís asignado y que la recorrida admite observaciones.'),
      action: 'Reintentar después de revisar',
      tone: 'warning',
      canRetry: true
    };
  }
  return {
    phase, heading,
    description: hasError
      ? `Último intento sin confirmar: ${draft.lastError}. Los mismos identificadores se conservarán para el reintento.`
      : defaultNext,
    action: 'Enviar ahora',
    tone: 'neutral',
    canRetry: true
  };
}

export function queueSummary(drafts) {
  const list = Array.isArray(drafts) ? drafts : [];
  return {
    pending: list.filter((item) => item.state === 'pending').length,
    review: list.filter((item) => item.state === 'conflict' || item.state === 'auth').length,
    photoOnly: list.filter((item) => Boolean(item.evidence && item.syncedObservationId)).length,
    total: list.length
  };
}
