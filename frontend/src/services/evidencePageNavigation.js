// Pure navigation guard: a next_cursor cannot point to this page or to
// any already visited page. Bad server/history state must never trap field
// users in an infinite traversal or overwrite a previous page.
export function advanceEvidencePage(cursors, nextCursor) {
  if (!Array.isArray(cursors) ||
      cursors.some(value => typeof value !== 'string' || !value) ||
      typeof nextCursor !== 'string' || !nextCursor ||
      cursors.includes(nextCursor)) {
    throw new Error('La navegación del historial no tiene un cursor nuevo válido.');
  }
  return [...cursors, nextCursor];
}

export function previousEvidencePage(cursors) {
  if (!Array.isArray(cursors) || !cursors.length) return [];
  return cursors.slice(0, -1);
}

export function isInvalidEvidenceCursor(error) {
  return error?.status === 400 && error?.code === 'EVIDENCE_CURSOR_INVALID';
}
