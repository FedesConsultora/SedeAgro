import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { API_URL, createApiClient } from '../services/api.js';
import { offlineQueue } from '../services/offlineQueue.js';
import { clearOfflineFieldVault, lockOfflineFieldVault } from '../services/offlineFieldVault.js';
import { retireOfflineFieldVault } from '../services/offlineVaultRetirement.js';
import { QUEUE_EVENT, sessionScope } from '../services/offlineSyncModel.js';
import { isCurrentSessionExpiry } from '../services/sessionExpiryScope.js';
import { createSessionTabSync, shouldRecheckOnForeground } from '../services/sessionTabSync.js';
import { useFeedback } from './FeedbackContext.jsx';

const SessionContext = createContext(null);

export const demoSession = {
  token: '',
  tenant: { id: '', name: 'Demo Agro', slug: 'demo-agro' },
  user: { fullName: 'Equipo SedeAgro' },
  entitlements: ['org', 'gis', 'campaigns', 'scouting', 'work_orders', 'analytics', 'reports', 'imagery']
};

function normalizeSession(value) {
  return {
    ...demoSession,
    ...value,
    tenant: {
      ...demoSession.tenant,
      ...(value?.tenant || {})
    },
    user: {
      ...demoSession.user,
      ...(value?.user || {})
    },
    membership: value?.membership || null,
    entitlements: Array.isArray(value?.entitlements) ? value.entitlements : demoSession.entitlements,
    authenticated: value?.authenticated === true
  };
}

// Never persist bearer credentials. Old installations may have left JWTs in
// localStorage; remove them before mounting the application.
localStorage.removeItem('sedeagro.session');
const tenantHint = localStorage.getItem('sedeagro.tenantHint') || '';

const storedDataMode = (() => {
  const value = localStorage.getItem('sedeagro.dataMode');
  return value === 'live' ? 'live' : 'mock';
})();

export function SessionProvider({ children }) {
  const [session, setSessionState] = useState(demoSession);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const authEpochRef = useRef(0);
  const [authEpoch, setAuthEpoch] = useState(0);
  const [restoring, setRestoring] = useState(Boolean(tenantHint));
  const [sessionCheckError, setSessionCheckError] = useState(false);
  const validationSequenceRef = useRef(0);
  const tabSyncRef = useRef(null);
  const retrySessionCheckRef = useRef(null);
  const [dataMode, setDataModeState] = useState(storedDataMode);
  const { startLoading, stopLoading, showError } = useFeedback();
  // Toast/loading counts change on EVERY request. Keep the transport identity
  // stable so those UI updates cannot abort an in-flight offline synchronization.
  const feedbackActions = useMemo(() => ({ startLoading, stopLoading, showError }),
    [startLoading, stopLoading, showError]);
  const api = useMemo(() => createApiClient(session, feedbackActions, authEpoch),
    [session, feedbackActions, authEpoch]);

  const setSession = (nextSession) => {
    const normalized = nextSession ? normalizeSession(nextSession) : demoSession;
    validationSequenceRef.current += 1;
    sessionRef.current = normalized;
    authEpochRef.current += 1;
    setAuthEpoch(authEpochRef.current);
    setSessionState(normalized);
    setRestoring(false);
    setSessionCheckError(false);
    if (nextSession?.tenant?.id) localStorage.setItem('sedeagro.tenantHint', normalized.tenant.id);
    else localStorage.removeItem('sedeagro.tenantHint');
    localStorage.removeItem('sedeagro.session');
  };

  const setDataMode = (nextMode) => {
    const normalized = nextMode === 'live' ? 'live' : 'mock';
    setDataModeState(normalized);
    localStorage.setItem('sedeagro.dataMode', normalized);
  };

  // Login helper: sets real session + switches to live mode
  const login = (data) => {
    const next = {
      authenticated: true,
      tenant: data.tenant,
      user: data.user,
      membership: data.membership,
      entitlements: data.entitlements || demoSession.entitlements
    };
    // A newly authenticated cookie may belong to a different account. Never
    // retain a prior actor's locally recoverable offline scope after login.
    lockOfflineFieldVault();
    void clearOfflineFieldVault().catch(() => {
      // A locked vault cannot be opened without its independent passphrase.
      // The operator can clear the browser's site storage if IDB is blocked.
    });
    setSession(next);
    setDataModeState('live');
    localStorage.setItem('sedeagro.dataMode', 'live');
    tabSyncRef.current?.publish();
  };


  // A server-confirmed logout is authoritative. IndexedDB may be blocked,
  // but that must not leave a revoked cookie session visible in React.
  const logout = async () => {
    try {
      await api.logout();
    } catch (error) {
      showError({ message: 'No se pudo cerrar la sesión en el servidor. Reintentá cuando tengas conexión.',
        status: error?.status || 0 });
      return;
    }

    // Lock any in-memory offline capability first. If removing the encrypted
    // envelope fails, still close the session and warn about device cleanup.
    const retirement = retireOfflineFieldVault();
    // Neither an IndexedDB failure nor a slow storage transaction may keep
    // the revoked user's private React views open after server ACK.
    setSession(null);
    setDataModeState('mock');
    localStorage.setItem('sedeagro.dataMode', 'mock');
    tabSyncRef.current?.publish();
    if (!(await retirement)) {
      showError({ message: 'Se cerró la sesión del servidor, pero no se pudo borrar el acceso offline local. Eliminá los datos del sitio antes de compartir este dispositivo.',
        status: 0 });
    }
  };

  // Cookie-based authentication: the JWT is HttpOnly and never visible here.
  const isAuthenticated = Boolean(session?.authenticated &&
    session?.user?.id && session?.tenant?.id);

  // A tab message never authenticates a user. It fences old requests, hides
  // private React views, and asks Express to verify the cookie and tenant anew.
  // A transient outage stays locked with a retry instead of claiming logout.
  useEffect(() => {
    let disposed = false;
    let lastAttemptAt = 0;
    let retryOnOnline = false;

    const revalidate = ({ quarantine = true } = {}) => {
      if (disposed) return Promise.resolve();
      const sequence = ++validationSequenceRef.current;
      if (quarantine) {
        // Do not call setSession(null): that would remove the *other* tab's
        // newly written tenant hint before we can verify its cookie.
        sessionRef.current = demoSession;
        authEpochRef.current += 1;
        setAuthEpoch(authEpochRef.current);
        setSessionState(demoSession);
      }
      const epoch = authEpochRef.current;
      const isCurrent = () => !disposed &&
        sequence === validationSequenceRef.current && epoch === authEpochRef.current;
      const hint = localStorage.getItem('sedeagro.tenantHint') || '';
      setRestoring(true);
      setSessionCheckError(false);
      if (!hint) {
        if (isCurrent()) {
          setSession(null);
          setDataModeState('mock');
          localStorage.setItem('sedeagro.dataMode', 'mock');
        }
        return Promise.resolve();
      }
      lastAttemptAt = Date.now();
      if (navigator.onLine === false) {
        if (isCurrent()) {
          retryOnOnline = true;
          setSessionCheckError(true);
          setRestoring(false);
        }
        return Promise.resolve();
      }
      return fetch(`${API_URL}/auth/me`, {
        credentials: 'include', headers: { 'x-tenant-id': hint }
      }).then(async (res) => {
        if ([401, 403, 404].includes(res.status)) return { unauthorized: true };
        if (!res.ok) throw new Error('Temporary session validation failure');
        const profile = await res.json();
        if (!profile?.user?.id || profile?.tenant?.id !== hint || !profile?.membership?.id) {
          throw new Error('Invalid session authority response');
        }
        return { profile };
      }).then((result) => {
        if (!isCurrent()) return;
        retryOnOnline = false;
        if (result.unauthorized) {
          lockOfflineFieldVault();
          void clearOfflineFieldVault().catch(() => {});
          setSession(null);
          setDataModeState('mock');
          localStorage.setItem('sedeagro.dataMode', 'mock');
        } else {
          setSession({ ...result.profile, authenticated: true });
          setDataModeState('live');
          localStorage.setItem('sedeagro.dataMode', 'live');
        }
      }).catch(() => {
        if (!isCurrent()) return;
        retryOnOnline = true;
        setSessionCheckError(true);
      }).finally(() => {
        if (isCurrent()) setRestoring(false);
      });
    };

    retrySessionCheckRef.current = () => revalidate({ quarantine: true });
    const sync = createSessionTabSync(() => {
      lockOfflineFieldVault();
      void clearOfflineFieldVault().catch(() => {});
      void revalidate({ quarantine: true });
    });
    tabSyncRef.current = sync;
    void revalidate({ quarantine: Boolean(tenantHint) });

    // A suspended/background tab may miss a browser event. Adopt TOP's
    // bounded foreground revalidation; never interrupt active offline work.
    const onForeground = () => {
      const hint = localStorage.getItem('sedeagro.tenantHint');
      if (!hint) return;
      // A login in another tab can set a new cookie and tenant hint while
      // this tab is hidden. Cross-tab notifications are advisory and may be
      // missed or delayed; foreground rechecks the SERVER rather than taking
      // the hint itself as permission to render private data.
      const current = sessionRef.current;
      const needsVerifiedIdentity = current?.authenticated !== true ||
        current?.tenant?.id !== hint;
      if (shouldRecheckOnForeground(lastAttemptAt, Date.now(),
        document.visibilityState === 'visible', navigator.onLine !== false,
        needsVerifiedIdentity)) {
        void revalidate({ quarantine: true });
      }
    };
    const onOnline = () => {
      if (retryOnOnline) void revalidate({ quarantine: true });
    };
    window.addEventListener('focus', onForeground);
    window.addEventListener('pageshow', onForeground);
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onForeground);
    return () => {
      disposed = true;
      validationSequenceRef.current += 1;
      if (tabSyncRef.current === sync) tabSyncRef.current = null;
      retrySessionCheckRef.current = null;
      sync.close();
      window.removeEventListener('focus', onForeground);
      window.removeEventListener('pageshow', onForeground);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onForeground);
    };
  }, []);

  useEffect(() => {
    const expired = (event) => {
      // Never let a delayed 401 from an old user, tenant or cookie generation
      // sign out the currently active session.
      if (!isCurrentSessionExpiry(event?.detail, sessionRef.current, authEpochRef.current)) return;
      // A stale 401 cannot revoke a newer login. A genuine current-session
      // expiry must retire the local unlock envelope as well as the React view.
      void retireOfflineFieldVault().then((cleared) => {
        if (!cleared) showError({
          message: 'La sesión expiró, pero no se pudo borrar el acceso offline local. Eliminá los datos del sitio antes de compartir este dispositivo.',
          status: 0
        });
      });
      setSession(null);
      setDataModeState('mock');
      localStorage.setItem('sedeagro.dataMode', 'mock');
      tabSyncRef.current?.publish();
    };
    window.addEventListener('sedeagro:session-expired', expired);
    return () => window.removeEventListener('sedeagro:session-expired', expired);
  }, []);

  // Only a live authenticated session may transmit locally persisted records.
  // The queue is partitioned by user and tenant, and retries use the immutable
  // original batch/idempotency key from IndexedDB.
  const syncScope = isAuthenticated && dataMode === 'live' ? sessionScope(session) : null;
  useEffect(() => {
    if (!syncScope) return undefined;
    const controller = new AbortController();
    let disposed = false;
    let retryTimer = null;
    const scheduleNext = async () => {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      if (disposed || navigator.onLine === false) return;
      try {
        const drafts = await offlineQueue.list(session);
        if (disposed) return;
        const due = drafts.filter((item) => item.state === 'pending')
          .map((item) => item.nextRetryAt ? Date.parse(item.nextRetryAt) : Date.now())
          .filter(Number.isFinite);
        if (!due.length) return;
        const delay = Math.max(1000, Math.min(300000, Math.min(...due) - Date.now()));
        retryTimer = setTimeout(() => dispatch(), delay);
      } catch (error) {
        if (!disposed) console.warn('offline_sync_schedule_failed', error?.message);
      }
    };
    const dispatch = (force = false) => {
      if (disposed || navigator.onLine === false) return;
      void offlineQueue.flush(
        session,
        (body) => api.submitSyncBatch(body, { signal: controller.signal }),
        {
          force,
          sendEvidence: (observationId, body) =>
            api.submitOfflineEvidence(observationId, body, { signal: controller.signal })
        }
      ).catch((error) => {
        // Do not discard pending records if storage or HTTP fails.
        if (!disposed) console.warn('offline_sync_flush_failed', error?.message);
      }).finally(() => { void scheduleNext(); });
    };
    const onOnline = () => dispatch(true);
    const onVisible = () => {
      if (document.visibilityState === 'visible') dispatch();
    };
    const onQueueUpdate = () => { dispatch(); void scheduleNext(); };
    dispatch();
    window.addEventListener('online', onOnline);
    window.addEventListener(QUEUE_EVENT, onQueueUpdate);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      disposed = true;
      controller.abort();
      if (retryTimer) clearTimeout(retryTimer);
      window.removeEventListener('online', onOnline);
      window.removeEventListener(QUEUE_EVENT, onQueueUpdate);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [syncScope, api, session]);

  const value = useMemo(() => ({
    session,
    setSession,
    dataMode,
    setDataMode,
    api,
    entitlements: session?.entitlements || [],
    isAuthenticated,
    restoring,
    sessionCheckError,
    retrySessionCheck: () => retrySessionCheckRef.current?.(),
    login,
    logout
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [session, dataMode, api, isAuthenticated, restoring]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession debe usarse dentro de SessionProvider');
  return value;
}
