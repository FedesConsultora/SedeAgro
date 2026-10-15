// The execution report is the authenticated operator's declaration, not
// telemetry or automatic proof that work physically occurred.
export const MAX_EXECUTION_REPORTS = 20;

export function canSubmitExecution(roleCode, assigned) {
  return roleCode === 'tenant_admin' || roleCode === 'agronomic_coordinator' ||
    (roleCode === 'contractor' && assigned);
}

export function canReviewExecution(roleCode, reviewerId, submitterId) {
  return Boolean(reviewerId && submitterId && reviewerId !== submitterId &&
    (roleCode === 'tenant_admin' || roleCode === 'agronomic_coordinator'));
}

export function canCloseReviewedOrder(roleCode, reports) {
  return (roleCode === 'tenant_admin' || roleCode === 'agronomic_coordinator') &&
    Array.isArray(reports) && reports.some(report => report.review_status === 'verified');
}

export function validExecutionWindow(started, finished, approved, now = new Date()) {
  return [started, finished, approved, now].every(date => date instanceof Date && Number.isFinite(date.getTime())) &&
    started.getTime() >= approved.getTime() &&
    finished.getTime() >= started.getTime() &&
    finished.getTime() <= now.getTime() + 5 * 60 * 1000;
}
