// Cross-tab messages are hints, never authorization. Only /auth/me can
// establish an authenticated tenant/user after another tab changes the cookie.
export const SESSION_TAB_KEY = 'sedeagro.auth-transition-v1';
// Retains ONLY an opaque transition nonce/source, never a user, tenant,
// cookie, membership, token or draft. A suspended tab can compare this on
// foreground after missing both transient BroadcastChannel/storage events.
export const SESSION_TAB_WITNESS_KEY = 'sedeagro.auth-transition-witness-v1';
const CHANNEL = 'sedeagro-auth-transitions-v1';
export const FOREGROUND_RECHECK_MS = 60_000;

export function shouldRecheckOnForeground(lastAttemptAt, now, visible, online) {
  return visible && online && Number.isFinite(now) &&
    (lastAttemptAt === 0 || now - lastAttemptAt >= FOREGROUND_RECHECK_MS);
}

export function isSessionTabSignal(value) {
  return Boolean(value && typeof value === 'object' &&
    value.kind === 'session-transition' &&
    typeof value.source === 'string' && value.source.length > 0 &&
    typeof value.nonce === 'string' && /^[0-9a-f-]{36}$/i.test(value.nonce) &&
    Object.keys(value).length === 3);
}

// Deliberately does NOT encode a tenant ID, user ID, token, cookie, draft,
// session epoch or evidence data. The legacy event key is still ephemeral.
// The new persistent witness is an opaque hint ONLY: a matching witness is
// never a substitute for the current cookie and /auth/me authorization.
export function createSessionTabSync(onTransition, browser = window) {
  const ownSource = browser.crypto.randomUUID();
  const seen = new Set();
  const readWitness = () => {
    try {
      const raw = browser.localStorage.getItem(SESSION_TAB_WITNESS_KEY);
      const value = raw && JSON.parse(raw);
      return isSessionTabSignal(value) ? value : null;
    } catch { return null; } // Storage can be disabled/private-mode blocked.
  };
  // A newly mounted tab already checks /auth/me; bootstrap the last hint to
  // avoid replaying an old transition on its first focus event.
  const initialWitness = readWitness();
  if (initialWitness) seen.add(initialWitness.nonce);
  const Channel = browser.BroadcastChannel;
  let channel = null;
  try {
    if (typeof Channel === 'function') channel = new Channel(CHANNEL);
  } catch { /* storage fallback */ }

  const receive = (signal) => {
    if (!isSessionTabSignal(signal) || signal.source === ownSource || seen.has(signal.nonce)) return false;
    seen.add(signal.nonce);
    if (seen.size > 32) seen.delete(seen.values().next().value);
    onTransition(); // Always quarantine first, then ask the REAL backend.
    return true;
  };
  const onStorage = (event) => {
    if (![SESSION_TAB_KEY, SESSION_TAB_WITNESS_KEY].includes(event.key) || !event.newValue) return;
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
        // Preserve the previous ephemeral notification behavior for legacy tabs.
        browser.localStorage.setItem(SESSION_TAB_KEY, JSON.stringify(signal));
        browser.localStorage.removeItem(SESSION_TAB_KEY);
        // A second last-transition key is retained for foreground recovery.
        // Its only contents are the opaque nonce and random tab-source ID.
        browser.localStorage.setItem(SESSION_TAB_WITNESS_KEY, JSON.stringify(signal));
      } catch { /* BroadcastChannel may still deliver the event */ }
    },
    catchUp() {
      // Safe if no storage support or if another tab's events arrived normally.
      // This is called on foreground and before adopting a late /auth/me
      // response. The witness itself NEVER authenticates the next account.
      return receive(readWitness());
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
