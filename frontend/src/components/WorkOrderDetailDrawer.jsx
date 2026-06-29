import { useState } from 'react';
import { ArrowRight, Calendar, MapPin, Tag, User } from 'lucide-react';
import { useSession } from '../context/SessionContext.jsx';
import { Drawer } from './Modal.jsx';

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

// Valid status transitions
const TRANSITIONS = {
  draft: ['pending_approval', 'cancelled'],
  pending_approval: ['approved', 'draft', 'cancelled'],
  approved: ['assigned', 'cancelled'],
  assigned: ['in_progress', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: []
};

export function WorkOrderDetailDrawer({ isOpen, onClose, order, onUpdated }) {
  const { api, dataMode } = useSession();
  const [currentStatus, setCurrentStatus] = useState(order.status);
  const [transitioning, setTransitioning] = useState(false);

  const doTransition = async (nextStatus) => {
    setTransitioning(true);
    try {
      if (dataMode === 'mock') {
        setCurrentStatus(nextStatus);
        return;
      }
      await api.request(`/work-orders/${order.id}/status`, {
        method: 'PATCH',
        body: { status: nextStatus }
      });
      setCurrentStatus(nextStatus);
      onUpdated?.();
    } catch {
      // Error handled by feedback system
    } finally {
      setTransitioning(false);
    }
  };

  const nextStates = TRANSITIONS[currentStatus] || [];

  return (
    <Drawer
      isOpen={isOpen}
      onClose={onClose}
      title={order.title}
      footer={
        nextStates.length > 0 ? (
          <div style={{ display: 'flex', gap: 8, width: '100%', flexWrap: 'wrap' }}>
            {nextStates.filter((s) => s !== 'cancelled').map((s) => (
              <button key={s} type="button" className="primary-action" style={{ fontSize: 13 }}
                disabled={transitioning} onClick={() => doTransition(s)}>
                <ArrowRight size={14} /> {STATUS_ES[s]}
              </button>
            ))}
            {nextStates.includes('cancelled') && (
              <button type="button" className="danger-action" style={{ marginLeft: 'auto' }}
                disabled={transitioning} onClick={() => doTransition('cancelled')}>
                Cancelar OT
              </button>
            )}
          </div>
        ) : null
      }
    >
      {/* Status Banner */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <span className={`status-badge status-badge--${currentStatus}`} style={{ fontSize: 13, minHeight: 28, padding: '0 12px' }}>
          {STATUS_ES[currentStatus] || currentStatus}
        </span>
        <span className={`status-badge status-badge--${PRIORITY_COLOR[order.priority] || 'gray'}`} style={{ fontSize: 13 }}>
          {PRIORITY_ES[order.priority]} prioridad
        </span>
      </div>

      {/* Info Rows */}
      <div className="detail-section">
        <h3>Información</h3>
        <div className="detail-row">
          <MapPin size={14} style={{ color: '#94a3b8', flexShrink: 0, marginTop: 1 }} />
          <span className="detail-row__label">Lote</span>
          <span className="detail-row__value">{order.Field?.name || '–'}</span>
        </div>
        <div className="detail-row">
          <Tag size={14} style={{ color: '#94a3b8', flexShrink: 0, marginTop: 1 }} />
          <span className="detail-row__label">Tipo</span>
          <span className="detail-row__value">{TYPE_ES[order.type] || order.type}</span>
        </div>
        {order.due_at && (
          <div className="detail-row">
            <Calendar size={14} style={{ color: '#94a3b8', flexShrink: 0, marginTop: 1 }} />
            <span className="detail-row__label">Vencimiento</span>
            <span className="detail-row__value">
              {new Date(order.due_at).toLocaleString('es-AR', { dateStyle: 'long', timeStyle: 'short' })}
            </span>
          </div>
        )}
        {order.assigned_to && (
          <div className="detail-row">
            <User size={14} style={{ color: '#94a3b8', flexShrink: 0, marginTop: 1 }} />
            <span className="detail-row__label">Asignado a</span>
            <span className="detail-row__value">{order.assigned_to}</span>
          </div>
        )}
      </div>

      {/* Instructions */}
      {order.instructions && (
        <div className="detail-section">
          <h3>Instrucciones</h3>
          <p style={{ fontSize: 14, color: '#334155', lineHeight: 1.6, margin: 0, background: 'rgba(0,0,0,0.02)', padding: '12px 16px', borderRadius: 8 }}>
            {order.instructions}
          </p>
        </div>
      )}

      {/* Assignees */}
      {order.WorkOrderAssignees?.length > 0 && (
        <div className="detail-section">
          <h3>Asignados ({order.WorkOrderAssignees.length})</h3>
          {order.WorkOrderAssignees.map((a) => (
            <div key={a.id} className="detail-row">
              <User size={14} style={{ color: '#94a3b8' }} />
              <span>{a.Membership?.User?.full_name || a.user_id}</span>
              <span className="status-badge status-badge--blue" style={{ marginLeft: 'auto', fontSize: 11 }}>{a.role || 'operario'}</span>
            </div>
          ))}
        </div>
      )}

      {/* Inputs */}
      {order.WorkOrderInputs?.length > 0 && (
        <div className="detail-section">
          <h3>Insumos</h3>
          {order.WorkOrderInputs.map((wi) => (
            <div key={wi.id} className="detail-row">
              <span className="detail-row__label">{wi.Input?.name || 'Insumo'}</span>
              <span className="detail-row__value">{wi.quantity} {wi.unit}</span>
            </div>
          ))}
        </div>
      )}

      {/* Machinery */}
      {order.WorkOrderMachinery?.length > 0 && (
        <div className="detail-section">
          <h3>Maquinaria</h3>
          {order.WorkOrderMachinery.map((wm) => (
            <div key={wm.id} className="detail-row">
              <span className="detail-row__value">{wm.Machine?.name || 'Máquina'}</span>
            </div>
          ))}
        </div>
      )}
    </Drawer>
  );
}
