import { HttpError } from '../../utils/http.js';

export function canReadScoutingRun(auth, run) {
  if (!auth || !run) return false;
  if (auth.role?.code !== 'scout') return true;
  return Boolean(run.assigned_to && run.assigned_to === auth.user?.id);
}

export function assertScoutingWritable(auth, run) {
  if (!run) throw new HttpError(404, 'Recorrida no encontrada.', undefined, 'SCOUTING_RUN_NOT_FOUND');
  if (!canReadScoutingRun(auth, run)) {
    throw new HttpError(404, 'Recorrida no encontrada.', undefined, 'SCOUTING_RUN_NOT_FOUND');
  }
  if (!['planned', 'in_progress'].includes(run.status)) {
    throw new HttpError(409, 'La recorrida ya está cerrada y no admite observaciones.', undefined, 'SCOUTING_RUN_CLOSED');
  }
}

export function assertRunTransition(current, next) {
  const transitions = {
    planned: ['in_progress', 'cancelled'],
    in_progress: ['completed', 'cancelled'],
    completed: [],
    cancelled: []
  };
  if (!Object.hasOwn(transitions, current) ||
      (next !== current && !transitions[current].includes(next))) {
    throw new HttpError(409, 'Transición de recorrida no permitida.', undefined, 'SCOUTING_STATUS_CONFLICT');
  }
}

export const ASSIGNABLE_ROLES = Object.freeze(['scout', 'agronomic_coordinator']);

export function assertRunAssignmentChange(run, nextAssignee) {
  if (run.assigned_to === nextAssignee) return;
  if (run.status !== 'planned') {
    throw new HttpError(409, 'Solo se puede cambiar el responsable de recorridas planificadas.',
      undefined, 'SCOUTING_REASSIGN_CONFLICT');
  }
}

export function assertRunReadyToStart(run, assignee) {
  if (!assignee) {
    throw new HttpError(409, 'Asigná un responsable activo antes de iniciar.',
      undefined, 'SCOUTING_ASSIGNEE_REQUIRED');
  }
}
