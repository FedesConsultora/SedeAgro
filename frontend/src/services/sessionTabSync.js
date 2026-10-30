// Cross-tab messages are hints, never authorization. Only /auth/me can
// establish an authenticated tenant/user after another tab changes the cookie.
export const SESSION_TAB_KEY = 'sedeagro.auth-transition-v1';
const CHANNEL = 'sedeagro-auth-transitions-v1';
export const FOREGROUND_RECHECK_MS = 60_000;
// A foreground tab can miss an advisory BroadcastChannel/storage event while
// suspended. If it has NO verified identity for the cookie's current tenant
// hint, it must recheck the real server promptly, not wait 60 seconds.
export const UNVERIFIED_FOREGROUND_RECHECK_MS = 1_000;

export function shouldRecheckOnForeground(
  lastAttemptAt, now, visible, online, needsVerifiedIdentity = false
) {
  if (!visible || !online || !Number.isFinite(now)) return false;
  if (lastAttemptAt === 0) return true;
  const elapsed = now - lastAttemptAt;
  return elapsed >= FOREGROUND_RECHECK_MS ||
    (needsVerifiedIdentity && elapsed >= UNVERIFIED_FOREGROUND_RECHECK_MS);
}

export function isSessionTabSignal(value) {
  return Boolean(value && typeof value === 'object' &&
    value.kind === 'session-transition' &&
    typeof value.source === 'string' && value.source.length > 0 &&
    typeof value.nonce === 'string' && /^[0-9a-f-]{36}$/i.test(value.nonce) &&
    Object.keys(value).length === 3);
}

// Deliberately does NOT encode a tenant ID, user ID, token, cookie, draft,
// session epoch or evidence data. BroadcastChannel is advisory; storage is a
// fallback for Safari/older browsers and is cleared immediately.
export function createSessionTabSync(onTransition, browser = window) {
  const ownSource = browser.crypto.randomUUID();
  const seen = new Set();
  const Channel = browser.BroadcastChannel;
  let channel = null;
  try {
    if (typeof Channel === 'function') channel = new Channel(CHANNEL);
  } catch { /* storage fallback */ }

  const receive = (signal) => {
    if (!isSessionTabSignal(signal) || signal.source === ownSource || seen.has(signal.nonce)) return;
    seen.add(signal.nonce);
    if (seen.size > 32) seen.delete(seen.values().next().value);
    onTransition();
  };
  const onStorage = (event) => {
    if (event.key !== SESSION_TAB_KEY || !event.newValue) return;
    try { receive(JSON.parse(event.newValue)); } catch { /* malformed event */ }
  };
  const onChannel = (event) => receive(event.data);
  browser.addEventListener('storage', onStorage);
  if (channel) channel.addEventListener('message', onChannel);

  return {
    publish() {
      const signal = { kind: 'session-transition', source: ownSource,
        nonce: browser.crypto.randomUUID() };
      try { channel?.postMessage(signal); } catch { /* storage fallback */ }
      try {
        browser.localStorage.setItem(SESSION_TAB_KEY, JSON.stringify(signal));
        browser.localStorage.removeItem(SESSION_TAB_KEY);
      } catch { /* BroadcastChannel may still deliver the event */ }
    },
    close() {
      browser.removeEventListener('storage', onStorage);
      if (channel) {
        channel.removeEventListener('message', onChannel);
        channel.close();
      }
    }
  };
}
