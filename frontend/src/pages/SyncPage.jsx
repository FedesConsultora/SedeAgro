import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, Clock, AlertTriangle, CheckCircle, Trash2, Send } from 'lucide-react';
import { useSession } from '../context/SessionContext.jsx';
import { mockData } from '../services/mockData.js';
import { offlineQueue } from '../services/offlineQueue.js';
import { guidanceForDraft, queueSummary } from '../services/offlineConflictGuidance.js';
import { QUEUE_EVENT, sessionScope } from '../services/offlineSyncModel.js';
import { browserStorageStatus, requestDurableStorage } from '../services/offlineStorageStatus.js';
import { OfflineReconciliationPanel } from '../components/OfflineReconciliationPanel.jsx';
import { OfflineFieldSetup } from '../components/OfflineFieldWorkspace.jsx';
import { filterSyncRunDrafts, filterSyncRunReceipts, resolveSyncRunFocus } from '../services/syncRunFocus.js';
import {
  syncReceiptPresentationScope, visibleSyncReceiptRows, checkedSyncReceiptRows
} from '../services/syncReceiptPresentationScope.js';

const STATUS_ES = {
  received: 'Recibido, no aplicado',
  processing: 'Procesando',
  processed: 'Aplicado',
  failed: 'Fallido',
  queued: 'Demo: en cola',
  completed: 'Demo: completado'
};
const STATUS_COLORS = {
  received: 'slate', processing: 'blue', processed: 'green',
  failed: 'rose', queued: 'slate', completed: 'green'
};
const QUEUE_STATUS = {
  pending: 'Pendiente de envío',
  conflict: 'Requiere revisión',
  auth: 'Sesión no autorizada'
};
const OBS_LABELS = {
  weed: 'Maleza', pest: 'Plaga', disease: 'Enfermedad', phenology: 'Fenología',
  nutrition: 'Nutrición', water: 'Agua', general: 'General'
};

export function SyncPage({ focusRunId = null, onClearFocus }) {
  const { api, dataMode, session } = useSession();
  const canListAll = ['tenant_admin', 'agronomic_coordinator'].includes(session?.membership?.roleCode);
  const focus = resolveSyncRunFocus(focusRunId);
  const activeScope = dataMode === 'live' ? sessionScope(session) : null;
  const serverScope = syncReceiptPresentationScope(session, dataMode);
  const scopeRef = useRef(activeScope);
  scopeRef.current = activeScope;
  const serverScopeRef = useRef(serverScope);
  serverScopeRef.current = serverScope;
  const serverApiRef = useRef(api);
  serverApiRef.current = api;
  const serverRequest = useRef(0);
  const [loadedServerScope, setLoadedServerScope] = useState(null);
  const [loadedServerApi, setLoadedServerApi] = useState(null);
  const [batches, setBatches] = useState([]);
  const [pending, setPending] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingLocal, setLoadingLocal] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendingOne, setSendingOne] = useState(null);
  const [online, setOnline] = useState(() => navigator.onLine !== false);
  const [error, setError] = useState('');
  const [localError, setLocalError] = useState('');
  const [notice, setNotice] = useState('');
  const [storageInfo, setStorageInfo] = useState(null);
  const [requestingPersistence, setRequestingPersistence] = useState(false);

  const loadData = useCallback(async () => {
    const requestId = ++serverRequest.current;
    setLoadedServerScope(serverScope);
    setLoadedServerApi(api);
    setLoading(true);
    setError('');
    setBatches([]);
    if (dataMode === 'mock') {
      setBatches(mockData.syncBatches || []);
      setLoading(false);
      return;
    }
    if (!serverScope) {
      setError('No se pudo verificar el acceso a recibos de sincronización.');
      setLoading(false);
      return;
    }
    const current = () => serverRequest.current === requestId &&
      serverScopeRef.current === serverScope && serverApiRef.current === api;
    try {
      const response = canListAll ? await api.syncBatches() : await api.mySyncBatches();
      if (!current()) return;
      setBatches(checkedSyncReceiptRows(response.data, session.tenant.id));
    } catch (err) {
      if (!current()) return;
      setBatches([]);
      setError(err?.message || 'No se pudo consultar el servidor de sincronización.');
    } finally {
      if (current()) setLoading(false);
    }
  }, [api, canListAll, dataMode, serverScope]);

  const loadLocal = useCallback(async () => {
    const requestedScope = dataMode === 'live' ? sessionScope(session) : null;
    if (!requestedScope) {
      setPending([]);
      setStorageInfo(null);
      setLocalError('');
      return;
    }
    setLoadingLocal(true);
    try {
      const rows = await offlineQueue.list(session);
      const info = await browserStorageStatus();
      if (scopeRef.current !== requestedScope) return;
      setPending(rows);
      setStorageInfo(info);
      setLocalError('');
    } catch (err) {
      if (scopeRef.current !== requestedScope) return;
      // Never leave a prior tenant/account's draft metadata on the screen
      // when the new scope cannot be decrypted.
      setPending([]);
      setStorageInfo(null);
      setLocalError(err?.message || 'No se pudo acceder a los datos guardados en este dispositivo.');
    } finally {
      if (scopeRef.current === requestedScope) setLoadingLocal(false);
    }
  }, [dataMode, session]);

  useEffect(() => { void loadData(); void loadLocal(); }, [loadData, loadLocal]);
  useEffect(() => {
    const changed = () => { void loadLocal(); };
    const onConnectivity = () => setOnline(navigator.onLine !== false);
    window.addEventListener(QUEUE_EVENT, changed);
    window.addEventListener('online', onConnectivity);
    window.addEventListener('offline', onConnectivity);
    return () => {
      window.removeEventListener(QUEUE_EVENT, changed);
      window.removeEventListener('online', onConnectivity);
      window.removeEventListener('offline', onConnectivity);
    };
  }, [loadLocal]);

  const sendPending = async () => {
    if (dataMode !== 'live' || !online || sending || sendingOne || focus.mode === 'invalid') return;
    // Background queue flush has scope-level semantics. A screen filter never
    // silently narrows transmission and must not imply selective delivery.
    if (focus.mode === 'run' && !window.confirm(
      'Enviar pendientes procesa TODAS las recorridas de esta cuenta, no solo la seleccionada. ¿Continuar?'
    )) return;
    setSending(true);
    setNotice('');
    setLocalError('');
    try {
      const result = await offlineQueue.flush(session,
        (body) => api.submitSyncBatch(body), {
          force: true,
          sendEvidence: (observationId, evidence) => api.submitOfflineEvidence(observationId, evidence)
        });
      await Promise.all([loadData(), loadLocal()]);
      const photoOnlyCount = Number.isSafeInteger(result.photoRecoveryRequired)
        ? result.photoRecoveryRequired : 0;
      setNotice(result.skipped ? 'La cola ya está siendo procesada en otra pestaña.'
        : `Envíos aplicados: ${result.sent}. Conflictos detectados: ${result.conflicts}.` +
          (photoOnlyCount > 0
            ? ` ${photoOnlyCount} fotografía(s) requieren conciliación: no reenviamos sus observaciones. En «Conciliar observaciones», verificá el recibo personal y recuperá solo la foto.`
            : ''));
    } catch (err) {
      setLocalError(err?.message || 'No se pudo procesar la cola.');
    } finally {
      setSending(false);
    }
  };

  const sendOne = async (item) => {
    // The selected row is only a presentation hint. The queue rereads the
    // immutable encrypted record under its scope lock before any HTTP call.
    const scope = activeScope;
    if (dataMode !== 'live' || !scope || !online || sending || sendingOne ||
      focus.mode === 'invalid' || item.scope !== scope ||
      !visiblePending.some(row => row.id === item.id)) return;
    if (item.evidence && item.syncedObservationId) {
      setNotice('La observación ya está aplicada. Recuperá solo su foto desde Conciliar observaciones.');
      return;
    }
    if (item.state !== 'pending' && !window.confirm(
      'Esta captura necesita revisión o una sesión renovada. Se reintentará SOLO esta captura, conservando sus identificadores. ¿Continuar?'
    )) return;
    setSendingOne(item.id);
    setNotice('');
    setLocalError('');
    try {
      const result = await offlineQueue.flushOne(session, item.id,
        (body) => api.submitSyncBatch(body), {
          sendEvidence: (observationId, evidence) => api.submitOfflineEvidence(observationId, evidence)
        });
      if (scopeRef.current !== scope) return;
      if (result.skipped) setNotice('Otra pestaña está procesando esta cuenta. Probá nuevamente.');
      else if (result.photoRecoveryRequired) setNotice(
        'Esta observación está aplicada: usá la recuperación de fotografía con recibo verificado.'
      );
      else if (result.invalidDraft) setLocalError(
        'La captura local cambió o está dañada. No se envió ningún dato.'
      );
      else if (result.missing) setNotice('La captura ya no se encuentra en este dispositivo.');
      else if (result.sent === 1) setNotice('Esta captura se confirmó y se retiró de la cola local.');
      else if (result.attempted === 1) setNotice(
        'No hubo confirmación completa del servidor. La captura permanece para reintentar.'
      );
      else setNotice('No se realizó el envío individual. Consultá su estado y actualizá.');
      await Promise.all([loadData(), loadLocal()]);
    } catch (err) {
      if (scopeRef.current === scope) {
        setLocalError(err?.message || 'No se pudo enviar esta captura. Los datos locales se conservan.');
      }
    } finally {
      if (scopeRef.current === scope) setSendingOne(null);
    }
  };

  const protectStorage = async () => {
    setRequestingPersistence(true);
    setLocalError('');
    try {
      const allowed = await requestDurableStorage();
      setStorageInfo(await browserStorageStatus());
      if (!allowed) {
        setNotice('El navegador no concedió almacenamiento persistente. Los borradores siguen cifrados, pero pueden eliminarse por falta de espacio.');
      } else {
        setNotice('El navegador concedió almacenamiento persistente para reducir el riesgo de eliminación automática.');
      }
    } catch (err) {
      setLocalError(err?.message || 'No se pudo proteger el almacenamiento local.');
    } finally {
      setRequestingPersistence(false);
    }
  };

  const discard = async (item) => {
    if (!window.confirm(item.syncedObservationId
      ? 'La observación ya fue confirmada en el servidor. ¿Eliminar la fotografía pendiente de este dispositivo? No podrás recuperarla.'
      : '¿Eliminar esta observación pendiente del dispositivo? No se podrá recuperar si nunca llegó al servidor.')) return;
    try {
      await offlineQueue.discard(session, item.id);
      await loadLocal();
    } catch (err) {
      setLocalError(err?.message || 'No se pudo eliminar la operación.');
    }
  };

  // While switching tenants/users, never render the old actor's decrypted
  // draft metadata or server receipts, even before the effects refetch them.
  const scopedPending = activeScope ? pending.filter(row => row.scope === activeScope) : [];
  const scopedBatches = visibleSyncReceiptRows(batches, loadedServerScope, loadedServerApi, serverScope, api);
  const visiblePending = filterSyncRunDrafts(scopedPending, activeScope, focus);
  const visibleBatches = filterSyncRunReceipts(scopedBatches, focus);
  const serverLoading = Boolean(serverScope && (loading || loadedServerScope !== serverScope || loadedServerApi !== api));
  const serverError = dataMode === 'live' && !serverScope
    ? 'No se pudo verificar el acceso a recibos de sincronización.'
    : loadedServerScope === serverScope && loadedServerApi === api ? error : '';
  const { pending: pendingCount, review: conflictCount, photoOnly } = queueSummary(scopedPending);

  return (
    <div className="page-grid">
      {dataMode === 'live' && session?.authenticated && navigator.onLine !== false &&
        <OfflineFieldSetup api={api} session={session} />}
      <section className="page-heading">
        <div>
          <span className="eyebrow">Operaciones de campo</span>
          <h1>Sincronizaciones</h1>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {dataMode === 'live' && <button type="button" className="primary-action"
            disabled={!online || sending || Boolean(sendingOne) || pendingCount === 0 || focus.mode === 'invalid'}
            onClick={() => void sendPending()}>
            <Send size={15}/> {sending ? 'Enviando…' : focus.mode === 'run' ? 'Enviar todos mis pendientes' : 'Enviar pendientes'}
          </button>}
          <button type="button" className="ghost-action"
            onClick={() => { void loadData(); void loadLocal(); }} disabled={loading || loadingLocal}>
            <RefreshCw size={15} className={loading ? 'spin' : ''}/> Actualizar
          </button>
        </div>
      </section>

      {focus.mode !== 'all' && <section className="admin-panel" aria-label="Filtro por recorrida"
        style={{ padding: '12px 16px', display: 'grid', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 12, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 13 }}>
            {focus.mode === 'run'
              ? `Recorrida seleccionada · ${focus.runId.slice(0, 8)}…`
              : 'Referencia de recorrida no válida'}
          </strong>
          <button className="ghost-action" type="button" onClick={() => onClearFocus?.()}>
            Ver todas las recorridas
          </button>
        </div>
        <p style={{ fontSize: 12, color: '#64748b', margin: 0 }} role="status">
          {focus.mode === 'run'
            ? 'Se filtran las capturas locales, sus opciones de conciliación y los recibos con recorrido verificable. El botón «Enviar todos mis pendientes» sigue procesando toda la cola de la cuenta.'
            : 'No se muestran capturas ni recibos por una referencia inválida. Podés quitar el filtro para consultar tus datos.'}
        </p>
      </section>}

      {dataMode === 'live' && <>
        <div className="toast-item toast-item--info" role="status" style={{ pointerEvents: 'auto', opacity: 1, transform: 'none', margin: '8px 0 16px' }}>
          <div className="toast-item__icon"><Clock size={16}/></div>
          <div className="toast-item__body">
            <strong className="toast-item__title">
              {online ? 'Conectado' : 'Sin conexión'} · En todas tus recorridas: {pendingCount} pendientes · {conflictCount} para revisar · {photoOnly} fotos por confirmar
            </strong>
            <p className="toast-item__message" style={{ fontSize: 12 }}>
              Las observaciones se guardan primero en este navegador y se envían al iniciar sesión,
              volver a conectar o seleccionar «Enviar pendientes». Un envío solo desaparece de la cola
              cuando el servidor confirma que lo aplicó.
            </p>
          </div>
        </div>
        <section className="admin-panel" style={{ padding: 16, display: 'grid', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <strong>En este dispositivo ({visiblePending.length})</strong>
            <span style={{ fontSize: 12, color: '#64748b' }}>Datos locales de esta cuenta y empresa</span>
          </div>
          <p style={{ margin: 0, fontSize: 12, color: '#a16207' }}>
            Los borradores se cifran con AES-256-GCM antes de guardarse. La clave permanece en
            este navegador: scripts del mismo origen con acceso a la sesión aún podrían
            descifrarlos. Usá un dispositivo confiable.
          </p>
          {storageInfo?.supported && (
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: 12 }}>
              <span>
                Espacio local estimado: {storageInfo.usage === null ? '—' : Math.round(storageInfo.usage / 1048576) + ' MiB'}
                {' / '}
                {storageInfo.quota === null ? '—' : Math.round(storageInfo.quota / 1048576) + ' MiB'}
              </span>
              <span>{storageInfo.persisted ? 'Almacenamiento persistente concedido' :
                'El navegador puede liberar datos si necesita espacio'}</span>
              {!storageInfo.persisted &&
                <button type="button" className="ghost-action" onClick={() => void protectStorage()}
                  disabled={requestingPersistence}>
                  {requestingPersistence ? 'Solicitando…' : 'Proteger almacenamiento'}
                </button>}
            </div>
          )}
          {localError && <div role="alert" className="auth-error">{localError}</div>}
          {notice && <p role="status" style={{ margin: 0, color: '#166534', fontSize: 12 }}>{notice}</p>}
          {!loadingLocal && !localError && visiblePending.length === 0 &&
            <p style={{ margin: 0, fontSize: 13, color: '#64748b' }}>
              {focus.mode === 'all'
                ? 'No hay observaciones pendientes. Las confirmadas aparecen en los recibos del servidor.'
                : 'No hay capturas locales que coincidan con esta recorrida. Esto no confirma que el servidor no tenga operaciones.'}
            </p>}
          {visiblePending.map((item) => (
            <div key={item.id} style={{ display: 'flex', justifyContent: 'space-between',
              alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '12px 4px',
              borderBottom: '1px solid rgba(15,23,42,0.08)' }}>
              <div style={{ minWidth: 200, flex: 1 }}>
                <strong style={{ fontSize: 13 }}>{OBS_LABELS[item.body.operations[0]?.payload?.observation_type] || 'Observación'}</strong>
                <div style={{ fontSize: 12, color: '#64748b' }}>
                  {QUEUE_STATUS[item.state] || item.state} · {new Date(item.createdAt).toLocaleString('es-AR')}
                  {' · '}Recorrida {item.runId.slice(0, 8)}…
                </div>
                <div style={{ fontSize: 12, fontWeight: 600, marginTop: 5, color: '#334155' }}>
                  {guidanceForDraft(item).heading}
                </div>
                {item.evidence && <div style={{ fontSize: 12, color: '#475569' }}>
                  Foto local: {item.evidence.original_name}
                </div>}
                <p role={item.state === 'conflict' || item.state === 'auth' ? 'alert' : 'status'}
                  style={{ margin: '4px 0 0', fontSize: 12, color:
                    item.state === 'pending' ? '#475569' : '#b45309' }}>
                  {guidanceForDraft(item).description}
                </p>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                {!(item.evidence && item.syncedObservationId) &&
                  <button type="button" className="ghost-action"
                    disabled={!online || sending || Boolean(sendingOne) || loadingLocal || Boolean(localError)}
                    onClick={() => void sendOne(item)}>
                    {sendingOne === item.id ? 'Enviando esta…' :
                      item.state === 'pending' ? 'Enviar solo esta' : 'Reintentar solo esta'}
                  </button>}
                {item.evidence && item.syncedObservationId &&
                  <span style={{ fontSize: 12, color: '#9a5a16' }}>
                    Recuperar foto en conciliación
                  </span>}
                <button type="button" className="ghost-action"
                  disabled={sending || Boolean(sendingOne)}
                  onClick={() => void discard(item)} aria-label="Eliminar observación pendiente">
                  <Trash2 size={14}/> Eliminar
                </button>
              </div>
            </div>
          ))}
        </section>
      </>}

      {dataMode === 'live' && <OfflineReconciliationPanel
        drafts={visiblePending}
        localLoading={loadingLocal}
        localError={localError}
        onLocalChange={loadLocal}
      />}

      {dataMode === 'mock' && <p role="status" style={{ color: '#a16207', fontSize: 12 }}>
        Vista demo: los estados que se muestran abajo no representan operaciones persistidas.
      </p>}
      <section className="admin-panel">
        <div style={{ padding: '14px 16px', fontWeight: 600 }}>Recibos del servidor</div>
        <p style={{ padding: '0 16px 12px', color: '#64748b', fontSize: 12 }}>
          Los lotes históricos «Recibido» no fueron aplicados automáticamente. Las operaciones nuevas
          figuran como «Aplicado» después de la confirmación PostgreSQL.
          {focus.mode !== 'all' && ' En este filtro solo aparecen recibos entre los 100 recientes con una operación que identifica esta recorrida. Un recibo sin identificador de recorrida no se atribuye por suposición.'}
        </p>
        {serverError && <div className="auth-error" role="alert">
          <AlertTriangle size={16}/> {serverError}
          <button type="button" onClick={() => void loadData()}>Reintentar</button>
        </div>}
        <div className="admin-tab-content" style={{ padding: 0 }}>
          <div className="admin-table">
            <div className="admin-table__head" style={{ gridTemplateColumns: '2fr 2fr 1fr 1fr' }}>
              <span>Cliente</span><span>Dispositivo</span><span>Operaciones</span><span>Estado</span>
            </div>
            {serverLoading ? <div className="empty-state"><span>Consultando servidor…</span></div>
              : serverError ? null : visibleBatches.length === 0 ? <div className="empty-state" style={{ padding: 40 }}>
                <CheckCircle size={30}/><h3>{focus.mode === 'all' ? 'Sin recibos' : 'Sin recibos identificables en esta recorrida'}</h3>
              </div> : visibleBatches.map((batch) => (
                <div key={batch.id} className="admin-table__row" style={{ gridTemplateColumns: '2fr 2fr 1fr 1fr' }}>
                  <strong>{batch.client_id}</strong>
                  <span className="admin-table__muted">{batch.device_id || 'Sin dispositivo'}</span>
                  <span>{Array.isArray(batch.SyncOperations) ? batch.SyncOperations.length : (batch.operations?.length || 0)} operaciones</span>
                  <span className={`status-badge status-badge--${STATUS_COLORS[batch.status] || 'slate'}`}>
                    {STATUS_ES[batch.status] || batch.status}
                  </span>
                </div>
              ))}
          </div>
        </div>
      </section>
    </div>
  );
}
