import { useEffect, useState } from 'react';
import { AlertTriangle, ArrowRight, Camera, MapPin, RefreshCw } from 'lucide-react';
import { useSession } from '../context/SessionContext.jsx';
import { offlineQueue } from '../services/offlineQueue.js';
import { QUEUE_EVENT, sessionScope } from '../services/offlineSyncModel.js';
import { canNavigateView } from '../services/navigationAccess.js';
import { LOCAL_CAPTURE_PHASES, runLocalCaptureSummary } from '../services/runOfflineCaptures.js';
import './run-offline-captures.css';

function formattedDate(date) {
  return date ? new Date(date).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })
    : 'Fecha local no disponible';
}

// Local, read-only companion to the authoritative ScoutingObservations list.
// It never renders notes, source image bytes or GPS coordinates and never
// merges queued records into the server's observation/map data.
export function RunOfflineCaptures({ runId, onOpenSync }) {
  const { dataMode, session, entitlements } = useSession();
  const access = { role: session?.membership?.roleCode || '', entitlements,
    platformAdmin: Boolean(session?.user?.isPlatformAdmin) };
  const allowed = dataMode === 'live' && canNavigateView('sync', access);
  const scope = allowed ? sessionScope(session) : null;
  const key = scope ? `${scope}:${runId}:${access.role}:${[...(entitlements || [])].sort().join(',')}` : null;
  const [state, setState] = useState({ key: null, phase: 'loading', summary: null, error: '' });
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let sequence = 0;
    const refresh = async () => {
      const current = ++sequence;
      if (!key || !scope) {
        setState({ key, phase: 'unavailable', summary: null, error: '' });
        return;
      }
      setState({ key, phase: 'loading', summary: null, error: '' });
      try {
        const rows = await offlineQueue.list(session);
        const summary = runLocalCaptureSummary(rows, session, runId);
        if (!cancelled && sequence === current) {
          setState({ key, phase: 'ready', summary, error: '' });
        }
      } catch (error) {
        if (!cancelled && sequence === current) {
          setState({ key, phase: 'error', summary: null,
            error: error?.message || 'No se pudieron consultar las capturas cifradas.' });
        }
      }
    };
    const changed = () => { void refresh(); };
    const resumed = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    void refresh();
    window.addEventListener(QUEUE_EVENT, changed);
    window.addEventListener('online', changed);
    window.addEventListener('offline', changed);
    document.addEventListener('visibilitychange', resumed);
    return () => {
      cancelled = true;
      sequence += 1;
      window.removeEventListener(QUEUE_EVENT, changed);
      window.removeEventListener('online', changed);
      window.removeEventListener('offline', changed);
      document.removeEventListener('visibilitychange', resumed);
    };
  }, [key, runId, scope, session, revision]);

  if (!key || !allowed) return null;
  const visible = state.key === key ? state :
    { key, phase: 'loading', summary: null, error: '' };
  const summary = visible.phase === 'ready' ? visible.summary : null;

  return (
    <section className="run-offline" aria-label="Capturas locales de esta recorrida">
      <div className="run-offline__heading">
        <div>
          <span className="run-offline__eyebrow">En este dispositivo · sin confirmar</span>
          <h3>Capturas locales de la recorrida</h3>
        </div>
        <button className="ghost-action" type="button"
          onClick={() => setRevision(value => value + 1)}
          disabled={visible.phase === 'loading'}>
          <RefreshCw size={14} aria-hidden="true" /> Actualizar
        </button>
      </div>
      <p className="run-offline__hint">
        Esta sección muestra únicamente borradores cifrados de tu cuenta y empresa.
        No están incluidos en las observaciones confirmadas ni en el croquis del lote.
      </p>
      {visible.phase === 'loading' &&
        <p className="run-offline__hint" role="status">Consultando capturas locales…</p>}
      {visible.phase === 'error' &&
        <p className="run-offline__error" role="alert">
          <AlertTriangle size={16} aria-hidden="true" /> {visible.error}
          No se puede afirmar que la cola esté vacía.
        </p>}
      {summary && <>
        <div className="run-offline__counts" role="status">
          <span>{summary.pendingObservations} observaciones sin confirmar</span>
          <span>{summary.pendingPhotos} fotografías por confirmar</span>
          <span>{summary.review} para revisar</span>
        </div>
        {summary.total === 0
          ? <p role="status" className="run-offline__hint">
              No hay capturas pendientes de esta recorrida en este navegador.
            </p>
          : <ol className="run-offline__list">
              {summary.entries.map((item) => (
                <li className="run-offline__item" key={item.id}>
                  <div className="run-offline__item-main">
                    <strong>{item.typeLabel} · {item.severityLabel}</strong>
                    <span>{formattedDate(item.createdAt)}</span>
                    <span className={item.state === 'conflict' || item.state === 'auth'
                      ? 'run-offline__phase run-offline__phase--warning'
                      : 'run-offline__phase'}>
                      {LOCAL_CAPTURE_PHASES[item.phase].label}
                    </span>
                    <small>{LOCAL_CAPTURE_PHASES[item.phase].help}</small>
                    <div className="run-offline__flags">
                      {item.hasGps && <span><MapPin size={13} aria-hidden="true" /> GPS en borrador</span>}
                      {item.hasPhoto && <span><Camera size={13} aria-hidden="true" /> Foto en borrador</span>}
                    </div>
                  </div>
                </li>
              ))}
            </ol>}
      </>}
      <div className="run-offline__footer">
        <p className="run-offline__hint">
          La observación sólo está aplicada cuando el servidor la confirma.
          Si ya se aplicó pero falta una foto, recuperala desde Sincronizaciones.
        </p>
        <button type="button" className="ghost-action"
          onClick={() => onOpenSync?.()}>
          Ver Sincronizaciones <ArrowRight size={14} aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}
