import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Clock, AlertTriangle, CheckCircle, Trash2, Send } from 'lucide-react';
import { useSession } from '../context/SessionContext.jsx';
import { mockData } from '../services/mockData.js';
import { offlineQueue } from '../services/offlineQueue.js';
import { QUEUE_EVENT } from '../services/offlineSyncModel.js';

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

export function SyncPage() {
  const { api, dataMode, session } = useSession();
  const canListAll = ['tenant_admin', 'agronomic_coordinator'].includes(session?.membership?.roleCode);
  const [batches, setBatches] = useState([]);
  const [pending, setPending] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingLocal, setLoadingLocal] = useState(false);
  const [sending, setSending] = useState(false);
  const [online, setOnline] = useState(() => navigator.onLine !== false);
  const [error, setError] = useState('');
  const [localError, setLocalError] = useState('');
  const [notice, setNotice] = useState('');

  const loadData = useCallback(async () => {
    setLoading(true);
    setError('');
    if (dataMode === 'mock') {
      setBatches(mockData.syncBatches || []);
      setLoading(false);
      return;
    }
    try {
      const response = canListAll ? await api.syncBatches() : await api.mySyncBatches();
      setBatches(response.data || []);
    } catch (err) {
      setBatches([]);
      setError(err?.message || 'No se pudo consultar el servidor de sincronización.');
    } finally {
      setLoading(false);
    }
  }, [api, canListAll, dataMode]);

  const loadLocal = useCallback(async () => {
    if (dataMode !== 'live') {
      setPending([]);
      return;
    }
    setLoadingLocal(true);
    try {
      setPending(await offlineQueue.list(session));
      setLocalError('');
    } catch (err) {
      setLocalError(err?.message || 'No se pudo acceder a los datos guardados en este dispositivo.');
    } finally {
      setLoadingLocal(false);
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
    if (dataMode !== 'live' || !online) return;
    setSending(true);
    setNotice('');
    setLocalError('');
    try {
      const result = await offlineQueue.flush(session,
        (body) => api.submitSyncBatch(body), { force: true });
      await Promise.all([loadData(), loadLocal()]);
      setNotice(result.skipped ? 'La cola ya está siendo procesada en otra pestaña.'
        : `Envíos aplicados: ${result.sent}. Conflictos detectados: ${result.conflicts}.`);
    } catch (err) {
      setLocalError(err?.message || 'No se pudo procesar la cola.');
    } finally {
      setSending(false);
    }
  };

  const retry = async (item) => {
    try {
      await offlineQueue.allowRetry(session, item.id);
      await loadLocal();
      if (online) await sendPending();
    } catch (err) {
      setLocalError(err?.message || 'No se pudo reintentar la operación.');
    }
  };

  const discard = async (item) => {
    if (!window.confirm('¿Eliminar esta observación pendiente del dispositivo? No se podrá recuperar si nunca llegó al servidor.')) return;
    try {
      await offlineQueue.discard(session, item.id);
      await loadLocal();
    } catch (err) {
      setLocalError(err?.message || 'No se pudo eliminar la operación.');
    }
  };

  const pendingCount = pending.filter((item) => item.state === 'pending').length;
  const conflictCount = pending.filter((item) => item.state !== 'pending').length;

  return (
    <div className="page-grid">
      <section className="page-heading">
        <div>
          <span className="eyebrow">Operaciones de campo</span>
          <h1>Sincronizaciones</h1>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {dataMode === 'live' && <button type="button" className="primary-action"
            disabled={!online || sending || pendingCount === 0}
            onClick={() => void sendPending()}>
            <Send size={15}/> {sending ? 'Enviando…' : 'Enviar pendientes'}
          </button>}
          <button type="button" className="ghost-action"
            onClick={() => { void loadData(); void loadLocal(); }} disabled={loading || loadingLocal}>
            <RefreshCw size={15} className={loading ? 'spin' : ''}/> Actualizar
          </button>
        </div>
      </section>

      {dataMode === 'live' && <>
        <div className="toast-item toast-item--info" role="status" style={{ pointerEvents: 'auto', opacity: 1, transform: 'none', margin: '8px 0 16px' }}>
          <div className="toast-item__icon"><Clock size={16}/></div>
          <div className="toast-item__body">
            <strong className="toast-item__title">
              {online ? 'Conectado' : 'Sin conexión'} · {pendingCount} pendientes · {conflictCount} para revisar
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
            <strong>En este dispositivo ({pending.length})</strong>
            <span style={{ fontSize: 12, color: '#64748b' }}>Datos locales de esta cuenta y empresa</span>
          </div>
          <p style={{ margin: 0, fontSize: 12, color: '#a16207' }}>
            Los borradores offline se guardan sin cifrar en el almacenamiento de este navegador.
            Usá un dispositivo confiable y eliminá las operaciones que no deban permanecer aquí.
          </p>
          {localError && <div role="alert" className="auth-error">{localError}</div>}
          {notice && <p role="status" style={{ margin: 0, color: '#166534', fontSize: 12 }}>{notice}</p>}
          {!loadingLocal && !localError && pending.length === 0 &&
            <p style={{ margin: 0, fontSize: 13, color: '#64748b' }}>
              No hay observaciones pendientes. Las confirmadas aparecen en los recibos del servidor.
            </p>}
          {pending.map((item) => (
            <div key={item.id} style={{ display: 'flex', justifyContent: 'space-between',
              alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '12px 4px',
              borderBottom: '1px solid rgba(15,23,42,0.08)' }}>
              <div style={{ minWidth: 200, flex: 1 }}>
                <strong style={{ fontSize: 13 }}>{OBS_LABELS[item.body.operations[0]?.payload?.observation_type] || 'Observación'}</strong>
                <div style={{ fontSize: 12, color: '#64748b' }}>
                  {QUEUE_STATUS[item.state] || item.state} · {new Date(item.createdAt).toLocaleString('es-AR')}
                  {' · '}Recorrida {item.runId.slice(0, 8)}…
                </div>
                {item.lastError && <p role="alert" style={{ margin: '4px 0 0', fontSize: 12, color: '#b45309' }}>
                  {item.lastError}
                </p>}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                {item.state !== 'pending' &&
                  <button type="button" className="ghost-action" onClick={() => void retry(item)}>Reintentar</button>}
                <button type="button" className="ghost-action"
                  onClick={() => void discard(item)} aria-label="Eliminar observación pendiente">
                  <Trash2 size={14}/> Eliminar
                </button>
              </div>
            </div>
          ))}
        </section>
      </>}

      {dataMode === 'mock' && <p role="status" style={{ color: '#a16207', fontSize: 12 }}>
        Vista demo: los estados que se muestran abajo no representan operaciones persistidas.
      </p>}
      <section className="admin-panel">
        <div style={{ padding: '14px 16px', fontWeight: 600 }}>Recibos del servidor</div>
        <p style={{ padding: '0 16px 12px', color: '#64748b', fontSize: 12 }}>
          Los lotes históricos «Recibido» no fueron aplicados automáticamente. Las operaciones nuevas
          figuran como «Aplicado» después de la confirmación PostgreSQL.
        </p>
        {error && <div className="auth-error" role="alert">
          <AlertTriangle size={16}/> {error}
          <button type="button" onClick={() => void loadData()}>Reintentar</button>
        </div>}
        <div className="admin-tab-content" style={{ padding: 0 }}>
          <div className="admin-table">
            <div className="admin-table__head" style={{ gridTemplateColumns: '2fr 2fr 1fr 1fr' }}>
              <span>Cliente</span><span>Dispositivo</span><span>Operaciones</span><span>Estado</span>
            </div>
            {loading ? <div className="empty-state"><span>Consultando servidor…</span></div>
              : error ? null : batches.length === 0 ? <div className="empty-state" style={{ padding: 40 }}>
                <CheckCircle size={30}/><h3>Sin recibos</h3>
              </div> : batches.map((batch) => (
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
