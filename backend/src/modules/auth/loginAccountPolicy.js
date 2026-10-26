// Global account status is independent from a tenant membership status.
// A valid tenant membership must never resurrect a blocked/deleted account.
// Do not reveal which part failed at public login: use the existing opaque 401.
export function canIssueLoginForGlobalAccount(user) {
  return Boolean(user && user.status === 'active');
}
