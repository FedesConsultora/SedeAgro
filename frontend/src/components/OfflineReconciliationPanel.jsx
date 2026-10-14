import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, RefreshCw, AlertTriangle, Image, MapPin } from 'lucide-react';
import { useSession } from '../context/SessionContext.jsx';
import { offlineQueue } from '../services/offlineQueue.js';
import { sessionScope } from '../services/offlineSyncModel.js';
import {
  parseMySyncReceipts, reconcileOfflineDraft, RECONCILIATION_STATUS
} from '../services/offlineReconciliation.js';
import './offline-reconciliation.css';

export function OfflineReconciliationPanel({ drafts, localLoading, localError, onLocalChange }) {
  const { api, session, dataMode } = useSession();
  const scope = dataMode === 'live' ? sessionScope(session) : null;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const seq = useRef(0);
  const [snapshot, setSnapshot] = useState({
    scope: null, phase: 'loading', rows: [], error: ''
  });
  const [working, setWorking] = useState(null);
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async () => {
    const requestId = ++seq.current;
    if (!scope) {
      setSnapshot({ scope: null, phase: 'unavailable', rows: [], error: '' });
      return;
    }
    setSnapshot({ scope, phase: 'loading', rows: [], error: '' });
    try {
      const response = await api.mySyncBatches();
      const rows = parseMySyncReceipts(response, session);
      if (seq.current === requestId && scopeRef.current === scope) {
        setSnapshot({ scope, phase: 'ready', rows, error: '' });
      }
    } catch (error) {
      if (seq.current === requestId && scopeRef.current === scope) {
        setSnapshot({ scope, phase: 'error', rows: [],
          error: error?.message || 'No se pudieron consultar los recibos personales.' });
      }
    }
  }, [api, scope, session]);

  useEffect(() => {
    void refresh();
    return () => { seq.current += 1; };
  }, [refresh]);

  useEffect(() => {
    setWorking(null);
    setActionError('');
    setNotice('');
  }, [scope]);

  useEffect(() => {
    if (!scope) return undefined;
    const onResume = () => {
      if (document.visibilityState === 'visible' && navigator.onLine !== false) void refresh();
    };
    const onOnline = () => void refresh();
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onResume);
    return () => {
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onResume);
    };
  }, [scope, refresh]);

  const visible = snapshot.scope === scope ? snapshot :
    { scope, phase: 'loading', rows: [], error: '' };
  const localRows = scope && !localError && !localLoading
    ? (Array.isArray(drafts) ? drafts.filter(item => item.scope === scope) : [])
    : [];
  const inspected = visible.phase === 'ready'
    ? localRows.map(draft => ({ draft, ...reconcileOfflineDraft(draft, visible.rows, session) }))
    : [];
  const confirmed = inspected.filter(item => item.status === 'confirmed');
  const photos = inspected.filter(item => item.status === 'photo_pending');
  const uncertain = inspected.filter(item => !['confirmed', 'photo_pending'].includes(item.status));

  const complete = async (draft) => {
    if (working || !scope || !window.confirm(
      'El servidor confirmó esta observación sin fotografía pendiente. ¿Quitar solamente su copia de este dispositivo? No se elimina la observación de PostgreSQL.'
    )) return;
    const expectedScope = scope;
    setWorking(draft.id);
    setActionError('');
    setNotice('');
    try {
      // A previously displayed GET is not enough: read current receipts
      // again, so a stale screen cannot authorize local data deletion.
      const response = await api.mySyncBatches();
      const currentReceipts = parseMySyncReceipts(response, session);
      if (scopeRef.current !== expectedScope) return;
      const matches = currentReceipts.filter(row =>
        row.idempotency_key === draft.idempotencyKey);
      if (matches.length !== 1 ||
        reconcileOfflineDraft(draft, matches, session).status !== 'confirmed') {
        throw new Error('La nueva consulta no confirmó esta observación. La copia local se conserva.');
      }
      const removed = await offlineQueue.confirmApplied(session, draft.id, matches[0]);
      if (scopeRef.current !== expectedScope) return;
      if (!removed) {
        setNotice('Otra pestaña pudo haber procesado la operación. Actualizá la lista.');
      } else {
        setNotice('Copia local conciliada y retirada. La observación continúa en PostgreSQL.');
      }
      await onLocalChange?.();
      await refresh();
    } catch (error) {
      if (scopeRef.current === expectedScope) {
        setActionError(error?.message || 'No se pudo verificar el recibo. El borrador permanece.');
      }
    } finally {
      if (scopeRef.current === expectedScope) setWorking(null);
    }
  };

  if (!scope || dataMode !== 'live') return null;

  return (
    <section className="offline-reconciliation" aria-label="Conciliación de observaciones offline">
      <div className="offline-reconciliation__heading">
        <div>
          <span className="offline-reconciliation__eyebrow">Comprobación contra PostgreSQL</span>
          <h2>Conciliar observaciones</h2>
        </div>
        <button type="button" className="ghost-action" onClick={() => void refresh()}
          disabled={visible.phase === 'loading' || Boolean(working)}>
          <RefreshCw size={15} aria-hidden="true" /> Verificar recibos
        </button>
      </div>
      <p className="offline-reconciliation__description">
        Se comparan los borradores cifrados de esta cuenta y empresa con los 100 recibos
        personales más recientes, usando la clave de envío, recorrida e identificador de operación.
        La ausencia de un recibo no demuestra que el envío falló.
      </p>
      {visible.phase === 'loading' && <p role="status" className="offline-reconciliation__hint">
        Comprobando recibos personales…
      </p>}
      {visible.phase === 'error' && <p role="alert" className="offline-reconciliation__error">
        <AlertTriangle size={16} aria-hidden="true" /> {visible.error} Ningún borrador se modificó.
      </p>}
      {localLoading && <p role="status" className="offline-reconciliation__hint">
        Leyendo borradores cifrados del dispositivo…
      </p>}
      {localError && <p role="alert" className="offline-reconciliation__error">
        Los borradores no se pudieron verificar: {localError}
      </p>}
      {actionError && <p role="alert" className="offline-reconciliation__error">{actionError}</p>}
      {notice && <p role="status" className="offline-reconciliation__notice">{notice}</p>}
      {visible.phase === 'ready' && !localLoading && !localError && <>
        <div className="offline-reconciliation__totals" role="status">
          <span><CheckCircle2 size={15} aria-hidden="true" /> {confirmed.length} aplicadas (sin foto pendiente)</span>
          <span><Image size={15} aria-hidden="true" /> {photos.length} fotos por confirmar</span>
          <span><AlertTriangle size={15} aria-hidden="true" /> {uncertain.length} sin confirmación verificable</span>
        </div>
        {inspected.length === 0 ? (
          <p className="offline-reconciliation__hint" role="status">
            Este dispositivo no tiene borradores pendientes para conciliar.
          </p>
        ) : <ul className="offline-reconciliation__list">
          {inspected.map(item => {
            const label = RECONCILIATION_STATUS[item.status] || RECONCILIATION_STATUS.unverified;
            const withGps = item.draft.body?.operations?.[0]?.payload?.point?.type === 'Point';
            return <li key={item.draft.id} className="offline-reconciliation__item">
              <div className="offline-reconciliation__item-main">
                <strong>{label.heading}</strong>
                <span>Recorrida {String(item.draft.runId).slice(0, 8)}…</span>
                <p>{label.detail}</p>
                <div className="offline-reconciliation__flags">
                  {withGps && <span><MapPin size={13} aria-hidden="true" /> GPS incluido</span>}
                  {item.draft.evidence && <span><Image size={13} aria-hidden="true" /> Fotografía conservada</span>}
                </div>
              </div>
              {item.status === 'confirmed' &&
                <button type="button" className="ghost-action"
                  disabled={Boolean(working)} onClick={() => void complete(item.draft)}>
                  {working === item.draft.id ? 'Verificando…' : 'Retirar copia confirmada'}
                </button>}
            </li>;
          })}
        </ul>}
      </>}
      <p className="offline-reconciliation__description">
        Esta verificación no reenvía datos, modifica GPS ni adjunta archivos.
        Las fotografías requieren confirmación independiente: un recibo de observación
        nunca autoriza eliminarlas del dispositivo.
      </p>
    </section>
  );
}
