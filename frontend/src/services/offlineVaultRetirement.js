// A successful server logout (or a current-session 401) must invalidate
// local offline access even if IndexedDB is unavailable. Storage deletion is
// best-effort; callers MUST still clear the React cookie-session view and
// notify the operator when a recoverable encrypted envelope may remain.
import { clearOfflineFieldVault, lockOfflineFieldVault } from './offlineFieldVault.js';

export async function retireOfflineFieldVault({
  lock = lockOfflineFieldVault,
  clear = clearOfflineFieldVault
} = {}) {
  lock();
  try {
    await clear();
    return true;
  } catch {
    return false;
  }
}
