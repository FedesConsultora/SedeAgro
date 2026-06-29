import { useEffect, useState } from 'react';
import { ClipboardList, Plus } from 'lucide-react';
import { useSession } from '../context/SessionContext.jsx';
import { mockData } from '../services/mockData.js';
import { WorkOrderFormModal } from '../components/WorkOrderFormModal.jsx';
import { WorkOrderDetailDrawer } from '../components/WorkOrderDetailDrawer.jsx';

const STATUS_ES = {
  draft: 'Borrador', pending_approval: 'Pend. aprobación', approved: 'Aprobado',
  assigned: 'Asignado', in_progress: 'En curso', completed: 'Completado', cancelled: 'Cancelado'
};
const PRIORITY_ES = { low: 'Baja', normal: 'Normal', high: 'Alta', urgent: 'Urgente' };
const TYPE_ES = {
  application: 'Aplicación', sowing: 'Siembra', fertilization: 'Fertilización',
  harvest: 'Cosecha', irrigation: 'Riego', inspection: 'Inspección', other: 'Otro'
};
const PRIORITY_COLOR = { low: 'gray', normal: 'blue', high: 'amber', urgent: 'rose' };

const STATUS_FILTER = ['Todos', 'assigned', 'in_progress', 'pending_approval', 'completed'];

function StatusBadge({ status }) {
  return <span className={`status-badge status-badge--${status}`}>{STATUS_ES[status] || status}</span>;
}

export function WorkOrdersPage() {
  const { api, dataMode } = useSession();
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('Todos');
  const [showModal, setShowModal] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState(null);

  const load = async () => {
    setLoading(true);
    if (dataMode === 'mock') { setOrders(mockData.workOrders); setLoading(false); return; }
    try {
      const res = await api.workOrders();
      setOrders(res.data || []);
    } catch {
      setOrders(mockData.workOrders);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [api, dataMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = filter === 'Todos' ? orders : orders.filter((o) => o.status === filter);

  return (
    <div className="page-grid">
      <section className="page-heading">
        <div>
          <span className="eyebrow">Operaciones de campo</span>
          <h1>Órdenes de trabajo</h1>
        </div>
        <button type="button" className="primary-action" onClick={() => setShowModal(true)}>
          <Plus size={16} /> Nueva orden
        </button>
      </section>

      <div className="page-toolbar">
        <div className="filter-bar">
          {STATUS_FILTER.map((s) => (
            <button key={s} type="button"
              className={`filter-chip ${filter === s ? 'filter-chip--active' : ''}`}
              onClick={() => setFilter(s)}>
              {s === 'Todos' ? 'Todos' : STATUS_ES[s] || s}
            </button>
          ))}
        </div>
        <span style={{ fontSize: 13, color: '#64748b' }}>{visible.length} órdenes</span>
      </div>

      {/* Table */}
      <div className="data-table-wrapper">
        <div className="data-table">
          <div className="data-table__row data-table__row--head"
            style={{ gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr 1fr' }}>
            <span>Título</span>
            <span>Lote</span>
            <span>Tipo</span>
            <span>Prioridad</span>
            <span>Estado</span>
            <span>Vencimiento</span>
          </div>

          {loading ? (
            <div style={{ padding: 24, color: '#94a3b8', fontSize: 13 }}>Cargando…</div>
          ) : visible.length === 0 ? (
            <div className="empty-state">
              <ClipboardList size={36} />
              <h3>Sin órdenes</h3>
              <p>Creá tu primera orden de trabajo para el campo.</p>
            </div>
          ) : (
            visible.map((order) => (
              <div key={order.id} className="data-table__row"
                style={{ gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr 1fr', cursor: 'pointer' }}
                onClick={() => setSelectedOrder(order)}>
                <strong>{order.title}</strong>
                <span>{order.Field?.name || '–'}</span>
                <span>{TYPE_ES[order.type] || order.type}</span>
                <span>
                  <span className={`status-badge status-badge--${PRIORITY_COLOR[order.priority] || 'gray'}`}>
                    {PRIORITY_ES[order.priority] || order.priority}
                  </span>
                </span>
                <span><StatusBadge status={order.status} /></span>
                <span>
                  {order.due_at ? new Date(order.due_at).toLocaleDateString('es-AR') : '–'}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      {showModal && (
        <WorkOrderFormModal isOpen onClose={() => setShowModal(false)} onCreated={() => { setShowModal(false); load(); }} />
      )}

      {selectedOrder && (
        <WorkOrderDetailDrawer
          isOpen
          order={selectedOrder}
          onClose={() => setSelectedOrder(null)}
          onUpdated={() => { setSelectedOrder(null); load(); }}
        />
      )}
    </div>
  );
}
