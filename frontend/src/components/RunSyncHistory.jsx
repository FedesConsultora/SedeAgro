import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, RefreshCw, RotateCcw } from 'lucide-react';
import { useSession } from '../context/SessionContext.jsx';
import { canNavigateView } from '../services/navigationAccess.js';
import { sessionScope } from '../services/offlineSyncModel.js';
import {
  buildRunPersonalSyncHistory, RUN_SYNC_HISTORY_PAGE_SIZE
} from '../services/runPersonalSyncHistory.js';
import './run-sync-history.css';

const shortId = value => value ? `${value.slice(0,8)}…` : 'ID no verificable';
const formatDate = value => value
  ? new Date(value).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })
  : 'Fecha no informada';

// Read-only server proof: never mixes these rows into ScoutingObservations or
// treats a confirmed observation as proof of a separate evidence upload.
export function RunSyncHistory({ runId }) {
  const { api, session, entitlements, dataMode } = useSession();
  const access = {
    role: session?.membership?.roleCode || '',
    entitlements, platformAdmin: Boolean(session?.user?.isPlatformAdmin)
  };
  const allowed = dataMode === 'live' && canNavigateView('sync', access);
  const scope = allowed ? sessionScope(session) : null;
  const contextKey = scope
    ? [scope, access.role, [...(entitlements || [])].sort().join(','), runId].join(':')
    : null;
  const currentContext = useRef(contextKey);
  currentContext.current = contextKey;
  const sequence = useRef(0);
  const [snapshot, setSnapshot] = useState({
    key: null, phase: 'loading', data: null, error: ''
  });
  const [visibleCount, setVisibleCount] = useState(RUN_SYNC_HISTORY_PAGE_SIZE);

  const refresh = useCallback(async () => {
    const requestId = ++sequence.current;
    if (!contextKey) {
      setSnapshot({ key: null, phase: 'unavailable', data: null, error: '' });
      return;
    }
    setSnapshot({ key: contextKey, phase: 'loading', data: null, error: '' });
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setSnapshot({ key: contextKey, phase: 'offline', data: null, error: '' });
      return;
    }
    try {
      // The personal endpoint requires sync.submit and tenant RLS. In
      // particular, do not use the admin/all-tenant GET /sync/batches.
      const response = await api.mySyncBatches();
      const data = buildRunPersonalSyncHistory(response, session, runId);
      if (sequence.current === requestId && currentContext.current === contextKey) {
        setSnapshot({ key: contextKey, phase: 'ready', data, error: '' });
      }
    } catch (error) {
      if (sequence.current === requestId && currentContext.current === contextKey) {
        setSnapshot({
          key: contextKey, phase: 'error', data: null,
          error: error?.message || 'No se pudieron verificar los recibos personales.'
        });
      }
    }
  }, [api, session, runId, contextKey]);

  useEffect(() => {
    setVisibleCount(RUN_SYNC_HISTORY_PAGE_SIZE);
    void refresh();
    return () => { sequence.current += 1; };
  }, [refresh]);

  useEffect(() => {
    if (!contextKey) return undefined;
    const onReconnect = () => { void refresh(); };
    const onDisconnect = () => {
      // In-flight success from a different connectivity period cannot turn
      // this screen green while offline.
      sequence.current += 1;
      if (currentContext.current === contextKey) {
        setSnapshot({ key: contextKey, phase: 'offline', data: null, error: '' });
      }
    };
    const onResume = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('online', onReconnect);
    window.addEventListener('offline', onDisconnect);
    document.addEventListener('visibilitychange', onResume);
    return () => {
      window.removeEventListener('online', onReconnect);
      window.removeEventListener('offline', onDisconnect);
      document.removeEventListener('visibilitychange', onResume);
    };
  }, [contextKey, refresh]);

  if (!contextKey || !allowed) return null;
  const visible = snapshot.key === contextKey ? snapshot :
    { key: contextKey, phase: 'loading', data: null, error: '' };
  const model = visible.phase === 'ready' ? visible.data : null;
  const entries = model?.entries.slice(0, visibleCount) || [];
  return (
    <section className="run-sync-history" aria-label="Historial personal de sincronización de la recorrida">
      <div className="run-sync-history__heading">
        <div>
          <span className="run-sync-history__eyebrow">Recibos del servidor · mi cuenta</span>
          <h3>Historial de sincronización</h3>
        </div>
        <button type="button" className="ghost-action"
          onClick={() => void refresh()} disabled={visible.phase === 'loading'}>
          <RefreshCw size={14} aria-hidden="true" /> Verificar recibos
        </button>
      </div>
      <p className="run-sync-history__hint">
        Sólo se muestran operaciones enviadas por tu cuenta que el servidor vincula a esta recorrida.
        El historial consulta hasta los 100 recibos personales más recientes, no todos los operadores.
      </p>
      {visible.phase === 'loading' && <p role="status" className="run-sync-history__hint">
        Consultando confirmaciones del servidor…
      </p>}
      {visible.phase === 'offline' && <p role="status" className="run-sync-history__hint">
        Sin conexión: no se puede verificar el historial. Los borradores locales se muestran por separado.
      </p>}
      {visible.phase === 'error' && <p role="alert" className="run-sync-history__error">
        <AlertTriangle size={16} aria-hidden="true" /> {visible.error}
        No se puede afirmar que no existan envíos.
      </p>}
      {model && <>
        <div className="run-sync-history__counts" role="status">
          <span><CheckCircle2 size={15} aria-hidden="true" /> {model.confirmed} operaciones aplicadas</span>
          <span><AlertTriangle size={15} aria-hidden="true" /> {model.unverified} sin verificación completa</span>
        </div>
        {model.entries.length === 0
          ? <p className="run-sync-history__hint" role="status">
              No hay operaciones atribuibles a esta recorrida entre los recibos personales consultados.
              Esto no demuestra que nunca se haya sincronizado.
            </p>
          : <ol className="run-sync-history__list">
              {entries.map(entry => (
                <li key={entry.key} className="run-sync-history__item">
                  <div>
                    <strong className={entry.status === 'confirmed'
                      ? 'run-sync-history__success' : 'run-sync-history__warning'}>
                      {entry.status === 'confirmed'
                        ? <CheckCircle2 size={15} aria-hidden="true" /> :
                          <AlertTriangle size={15} aria-hidden="true" />}
                      {entry.status === 'confirmed' ? 'Aplicada en PostgreSQL' : 'Confirmación inconsistente'}
                    </strong>
                    <div className="run-sync-history__metadata">
                      <span>Recibo {shortId(entry.batchId)}</span>
                      {entry.observationId && <span>Observación {shortId(entry.observationId)}</span>}
                      <span>{formatDate(entry.timestamp)}</span>
                    </div>
                    {entry.status !== 'confirmed' &&
                      <p className="run-sync-history__hint">
                        El resultado no prueba una aplicación única. Conservá cualquier borrador local.
                      </p>}
                  </div>
                </li>
              ))}
            </ol>}
        {model.entries.length > visibleCount && <button type="button"
          className="ghost-action run-sync-history__more"
          onClick={() => setVisibleCount(count => count + RUN_SYNC_HISTORY_PAGE_SIZE)}>
          Ver más operaciones ({model.entries.length - visibleCount} restantes)
        </button>}
        {model.atLimit && <p className="run-sync-history__hint">
          Se alcanzó el límite de 100 recibos por consulta: pueden existir envíos anteriores no visibles.
        </p>}
      </>}
      <p className="run-sync-history__hint run-sync-history__disclaimer">
        <RotateCcw size={14} aria-hidden="true" />
        Un recibo de observación confirma únicamente la operación indicada.
        No demuestra que una fotografía se haya cargado; su confirmación es independiente.
      </p>
    </section>
  );
}
