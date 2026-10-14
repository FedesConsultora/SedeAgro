import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { createApiClient } from '../services/api.js';
import { offlineQueue } from '../services/offlineQueue.js';
import { QUEUE_EVENT, sessionScope } from '../services/offlineSyncModel.js';
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
    entitlements: value?.entitlements?.length ? value.entitlements : demoSession.entitlements
  };
}

const storedSession = (() => {
  try {
    return normalizeSession(JSON.parse(localStorage.getItem('sedeagro.session')));
  } catch {
    return demoSession;
  }
})();

const storedDataMode = (() => {
  const value = localStorage.getItem('sedeagro.dataMode');
  return value === 'live' ? 'live' : 'mock';
})();

export function SessionProvider({ children }) {
  const [session, setSessionState] = useState(storedSession);
  const [dataMode, setDataModeState] = useState(storedDataMode);
  const feedback = useFeedback();
  const api = useMemo(() => createApiClient(session, feedback), [session, feedback]);

  const setSession = (nextSession) => {
    const normalized = nextSession ? normalizeSession(nextSession) : demoSession;
    setSessionState(normalized);
    if (nextSession) localStorage.setItem('sedeagro.session', JSON.stringify(normalized));
    else localStorage.removeItem('sedeagro.session');
  };

  const setDataMode = (nextMode) => {
    const normalized = nextMode === 'live' ? 'live' : 'mock';
    setDataModeState(normalized);
    localStorage.setItem('sedeagro.dataMode', normalized);
  };

  // Login helper: sets real session + switches to live mode
  const login = (data) => {
    const next = {
      token: data.token,
      tenant: data.tenant,
      user: data.user,
      membership: data.membership,
      entitlements: data.entitlements || demoSession.entitlements
    };
    setSession(next);
    setDataModeState('live');
    localStorage.setItem('sedeagro.dataMode', 'live');
  };


  // Logout: clears session + returns to mock/demo mode
  const logout = () => {
    setSession(null);
    setDataModeState('mock');
    localStorage.setItem('sedeagro.dataMode', 'mock');
  };

  // True only when a real JWT token + tenant ID are present
  const isAuthenticated = useMemo(() => {
    return !!(
      session?.token && session.token.length > 0 &&
      session?.tenant?.id && session.tenant.id.length > 0
    );
  }, [session]);

  // Only a live authenticated session may transmit locally persisted records.
  // The queue is partitioned by user and tenant, and retries use the immutable
  // original batch/idempotency key from IndexedDB.
  const syncScope = isAuthenticated && dataMode === 'live' ? sessionScope(session) : null;
  useEffect(() => {
    if (!syncScope) return undefined;
    const controller = new AbortController();
    let disposed = false;
    const dispatch = (force = false) => {
      if (disposed || navigator.onLine === false) return;
      void offlineQueue.flush(
        session,
        (body) => api.submitSyncBatch(body, { signal: controller.signal }),
        { force }
      ).catch((error) => {
        // Do not discard pending records if storage or HTTP fails.
        if (!disposed) console.warn('offline_sync_flush_failed', error?.message);
      });
    };
    const onOnline = () => dispatch(true);
    const onVisible = () => {
      if (document.visibilityState === 'visible') dispatch();
    };
    const onQueueUpdate = () => dispatch();
    dispatch();
    window.addEventListener('online', onOnline);
    window.addEventListener(QUEUE_EVENT, onQueueUpdate);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      disposed = true;
      controller.abort();
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
    login,
    logout
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [session, dataMode, api, isAuthenticated]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession debe usarse dentro de SessionProvider');
  return value;
}
