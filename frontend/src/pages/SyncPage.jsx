import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Clock, AlertTriangle, CheckCircle } from 'lucide-react';
import { useSession } from '../context/SessionContext.jsx';
import { mockData } from '../services/mockData.js';

const STATUS_ES = {
  received: 'Recibido, pendiente',
  processing: 'Procesando',
  processed: 'Aplicado',
  failed: 'Fallido',
  queued: 'Demo: en cola',
  completed: 'Demo: completado'
};
const STATUS_COLORS = {
  received: 'slate',
  processing: 'blue',
  processed: 'green',
  failed: 'rose',
  queued: 'slate',
  completed: 'green'
};

export function SyncPage() {
  const { api, dataMode, session } = useSession();
  const role = session?.membership?.roleCode;
  const canListAll = ['tenant_admin', 'agronomic_coordinator'].includes(role);
  const [batches, setBatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

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

  useEffect(() => { void loadData(); }, [loadData]);

  return (
    <div className="page-grid">
      <section className="page-heading">
        <div>
          <span className="eyebrow">Operaciones sin conexión</span>
          <h1>Sincronizaciones</h1>
        </div>
        <button type="button" className="primary-action"
          onClick={() => void loadData()} disabled={loading}>
          <RefreshCw size={15} className={loading ? 'spin' : ''} />
          {loading ? 'Consultando…' : 'Actualizar estado'}
        </button>
      </section>
      <div className="toast-item toast-item--info" style={{ pointerEvents: 'auto', opacity: 1, transform: 'none', margin: '10px 0 20px 0' }}>
        <div className="toast-item__icon"><Clock size={16}/></div>
        <div className="toast-item__body">
          <strong className="toast-item__title">Estado real de los lotes recibidos</strong>
          <p className="toast-item__message" style={{ fontSize: 12 }}>
            El backend aplica atómicamente las observaciones compatibles y registra sus resultados.
            La aplicación web solo consulta estos resultados: todavía no existe un motor móvil
            que sincronice automáticamente cuando se recupera la conexión.
            Un lote antiguo en estado «Recibido» no significa que se haya aplicado.
          </p>
        </div>
      </div>
      {dataMode === 'mock' && (
        <p role="status" style={{ fontSize: 12, color: '#a16207' }}>
          Vista de demostración: los estados no representan operaciones guardadas.
        </p>
      )}
      {error && <div className="auth-error" role="alert">
        <AlertTriangle size={16}/> {error}
        <button type="button" onClick={() => void loadData()}>Reintentar</button>
      </div>}
      <div className="admin-panel">
        <div className="admin-tab-content" style={{ padding: 0 }}>
          <div className="admin-table">
            <div className="admin-table__head" style={{ gridTemplateColumns: '2fr 2fr 1fr 1fr' }}>
              <span>Cliente móvil</span>
              <span>Dispositivo</span>
              <span>Operaciones</span>
              <span>Estado</span>
            </div>
            {loading ? <div className="empty-state"><span>Consultando lotes…</span></div>
              : error ? null
              : batches.length === 0 ? (
                <div className="empty-state" style={{ padding: 48 }}>
                  <CheckCircle size={32}/>
                  <h3>Sin lotes recibidos</h3>
                  <p>Todavía no se registraron envíos de sincronización para esta vista.</p>
                </div>
              ) : batches.map((batch) => (
                <div key={batch.id} className="admin-table__row" style={{ gridTemplateColumns: '2fr 2fr 1fr 1fr' }}>
                  <strong>{batch.client_id}</strong>
                  <span className="admin-table__muted">{batch.device_id || 'Sin dispositivo'}</span>
                  <span>{Array.isArray(batch.SyncOperations) ? batch.SyncOperations.length :
                    (batch.operations?.length || 0)} operaciones</span>
                  <span><span className={`status-badge status-badge--${STATUS_COLORS[batch.status] || 'slate'}`}>
                    {STATUS_ES[batch.status] || batch.status}
                  </span></span>
                </div>
              ))}
          </div>
        </div>
      </div>
    </div>
  );
}
