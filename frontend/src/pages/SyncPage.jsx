import { useEffect, useState } from 'react';
import { RefreshCw, CheckCircle, Clock, AlertTriangle, Play, HelpCircle } from 'lucide-react';
import { useSession } from '../context/SessionContext.jsx';
import { mockData } from '../services/mockData.js';

const STATUS_ES = {
  queued: 'En cola',
  processing: 'Procesando',
  completed: 'Completado',
  failed: 'Fallido'
};

const STATUS_COLORS = {
  queued: 'slate',
  processing: 'blue',
  completed: 'green',
  failed: 'rose'
};

export function SyncPage() {
  const { api, dataMode } = useSession();
  const [batches, setBatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const loadData = async () => {
    setLoading(true);
    if (dataMode === 'mock') {
      setBatches(mockData.syncBatches || []);
      setLoading(false);
      return;
    }
    try {
      const res = await api.syncBatches();
      setBatches(res.data || []);
    } catch {
      setBatches(mockData.syncBatches || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [api, dataMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const triggerSync = async () => {
    setSyncing(true);
    setTimeout(() => {
      setSyncing(false);
      loadData();
    }, 1500);
  };

  return (
    <div className="page-grid">
      <section className="page-heading">
        <div>
          <span className="eyebrow">Offline first</span>
          <h1>Sincronización móvil</h1>
        </div>
        <button
          type="button"
          className="primary-action"
          onClick={triggerSync}
          disabled={syncing}
        >
          <RefreshCw size={15} className={syncing ? 'spin' : ''} /> {syncing ? 'Sincronizando…' : 'Sincronizar ahora'}
        </button>
      </section>

      {/* Info Warning */}
      <div className="toast-item toast-item--info" style={{ pointerEvents: 'auto', opacity: 1, transform: 'none', margin: '10px 0 20px 0' }}>
        <div className="toast-item__icon"><Clock size={16} /></div>
        <div className="toast-item__body">
          <strong className="toast-item__title">Operaciones sin conexión</strong>
          <p className="toast-item__message" style={{ fontSize: 12 }}>
            SedeAgro Mobile procesa observaciones y recorridas a nivel local. Cuando recuperás conexión, los paquetes de datos (batches) se encolan y consolidan automáticamente en el servidor para evitar solapamientos.
          </p>
        </div>
      </div>

      <div className="admin-panel">
        <div className="admin-tab-content" style={{ padding: 0 }}>
          <div className="admin-table">
            <div className="admin-table__head" style={{ gridTemplateColumns: '2fr 2fr 1fr 1fr' }}>
              <span>Cliente Móvil</span>
              <span>Dispositivo</span>
              <span>Operaciones</span>
              <span>Estado</span>
            </div>
            {loading ? (
              <div className="empty-state"><span>Cargando lotes de sincronización…</span></div>
            ) : batches.length === 0 ? (
              <div className="empty-state" style={{ padding: 48 }}>
                <Clock size={32} />
                <h3>Sin sincronizaciones</h3>
                <p>Ningún dispositivo móvil ha enviado lotes de datos todavía.</p>
              </div>
            ) : (
              batches.map((b) => (
                <div key={b.id} className="admin-table__row" style={{ gridTemplateColumns: '2fr 2fr 1fr 1fr' }}>
                  <strong>{b.client_id}</strong>
                  <span className="admin-table__muted">{b.device_id || 'Desconocido'}</span>
                  <span>{Array.isArray(b.operations) ? b.operations.length : b.SyncOperations?.length || 0} items</span>
                  <span>
                    <span className={`status-badge status-badge--${STATUS_COLORS[b.status] || 'slate'}`}>
                      {STATUS_ES[b.status] || b.status}
                    </span>
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
