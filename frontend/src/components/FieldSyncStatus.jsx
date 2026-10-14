import { useEffect, useState } from 'react';
import { AlertTriangle, CloudOff, RefreshCw } from 'lucide-react';
import { useSession } from '../context/SessionContext.jsx';
import { offlineQueue } from '../services/offlineQueue.js';
import { queueSummary } from '../services/offlineConflictGuidance.js';
import { QUEUE_EVENT, sessionScope } from '../services/offlineSyncModel.js';
import { canNavigateView } from '../services/navigationAccess.js';
import './field-status.css';

function onlineNow() {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

export function FieldSyncStatus({ onViewChange }) {
  const { session, dataMode, entitlements } = useSession();
  const access = { entitlements, role: session?.membership?.roleCode || '',
    platformAdmin: Boolean(session?.user?.isPlatformAdmin) };
  const canView = canNavigateView('sync', access) && dataMode === 'live';
  const scope = canView ? sessionScope(session) : null;
  const [online, setOnline] = useState(onlineNow);
  const [status, setStatus] = useState({
    scope: null, state: 'loading', summary: null, error: ''
  });

  useEffect(() => {
    let disposed = false;
    let requestNumber = 0;
    const refresh = async () => {
      const request = ++requestNumber;
      if (!scope) {
        setStatus({ scope: null, state: 'unavailable', summary: null, error: '' });
        return;
      }
      setStatus({ scope, state: 'loading', summary: null, error: '' });
      try {
        const rows = await offlineQueue.list(session);
        if (!disposed && request === requestNumber) {
          setStatus({ scope, state: 'ready', summary: queueSummary(rows), error: '' });
        }
      } catch (error) {
        if (!disposed && request === requestNumber) {
          setStatus({ scope, state: 'error', summary: null,
            error: error?.message || 'No se pudo abrir la cola local.' });
        }
      }
    };
    const changed = () => { void refresh(); };
    const connectivity = () => {
      setOnline(onlineNow());
      void refresh();
    };
    const onResume = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    void refresh();
    window.addEventListener(QUEUE_EVENT, changed);
    window.addEventListener('online', connectivity);
    window.addEventListener('offline', connectivity);
    document.addEventListener('visibilitychange', onResume);
    return () => {
      disposed = true;
      requestNumber += 1;
      window.removeEventListener(QUEUE_EVENT, changed);
      window.removeEventListener('online', connectivity);
      window.removeEventListener('offline', connectivity);
      document.removeEventListener('visibilitychange', onResume);
    };
  }, [scope, session]);

  if (!scope || !canView) return null;

  const visible = status.scope === scope ? status :
    { scope, state: 'loading', summary: null, error: '' };
  const summary = visible.state === 'ready' ? visible.summary : null;
  const review = summary?.review || 0;
  const pending = summary?.pending || 0;
  const uncertain = visible.state === 'error' || visible.state === 'loading';
  const label = visible.state === 'error'
    ? 'Cola local no disponible'
    : visible.state === 'loading' ? 'Consultando pendientes'
      : review ? `${review} para revisar`
        : pending ? `${pending} por enviar`
          : online ? 'Cola al día' : 'Sin conexión';

  return (
    <button type="button"
      className={'field-sync-status' + (review || visible.state === 'error' ? ' field-sync-status--warning' : '')}
      title={visible.state === 'error' ? visible.error :
        `${label}. Abrir Sincronizaciones`}
      aria-label={`Sincronización: ${label}. Abrir Sincronizaciones`}
      onClick={() => onViewChange?.('sync')}>
      {review || visible.state === 'error' ? <AlertTriangle size={15} aria-hidden="true" /> :
        online ? <RefreshCw size={15} aria-hidden="true" /> :
          <CloudOff size={15} aria-hidden="true" />}
      <span>{label}</span>
      {!uncertain && summary?.photoOnly > 0 &&
        <span className="field-sync-status__photo" title="Fotografías pendientes de confirmar">
          {summary.photoOnly} fotos
        </span>}
    </button>
  );
}
