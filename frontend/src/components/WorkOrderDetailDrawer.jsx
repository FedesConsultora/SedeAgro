import { useEffect, useState } from 'react';
import { ArrowRight, Calendar, MapPin, RefreshCw, Tag, User } from 'lucide-react';
import { useSession } from '../context/SessionContext.jsx';
import { availableWorkOrderTransitions, validateWorkOrderDetail, WORK_ORDER_STATUS_LABELS } from '../services/workOrderDetails.js';
import { Drawer } from './Modal.jsx';
import './work-order-detail.css';

const PRIORITY_ES = { low: 'Baja', normal: 'Normal', high: 'Alta', urgent: 'Urgente' };
const TYPE_ES = {
  application: 'Aplicación', sowing: 'Siembra', fertilization: 'Fertilización',
  harvest: 'Cosecha', irrigation: 'Riego', inspection: 'Inspección', other: 'Otro'
};
const PRIORITY_COLOR = { low: 'gray', normal: 'blue', high: 'amber', urgent: 'rose' };

function dateLabel(value) {
  if (!value) return 'Sin fecha';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Fecha no disponible';
  return date.toLocaleString('es-AR', { dateStyle: 'medium', timeStyle: 'short' });
}

function InfoRow({ label, value, icon: Icon }) {
  return <div className="detail-row">
    <Icon size={15} aria-hidden="true" className="order-detail__row-icon" />
    <span className="detail-row__label">{label}</span>
    <span className="detail-row__value">{value || 'No informado'}</span>
  </div>;
}

export function WorkOrderDetailDrawer({ isOpen, onClose, order, onUpdated }) {
  const { api, dataMode, session } = useSession();
  const [detail, setDetail] = useState(dataMode === 'mock' ? order : null);
  const [loading, setLoading] = useState(dataMode === 'live');
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [transitioning, setTransitioning] = useState(false);
  const [revision, setRevision] = useState(0);

  // The list item only identifies the resource. In live mode the server must
  // authorize and return this specific order before any action is displayed.
  useEffect(() => {
    if (!isOpen) return undefined;
    let active = true;
    setLoadError('');
    setDetail(dataMode === 'mock' ? order : null);
    setLoading(dataMode === 'live');
    if (dataMode === 'mock') return () => { active = false; };

    api.request(`/work-orders/${encodeURIComponent(order.id)}`, { silent: true })
      .then(response => {
        if (active) setDetail(validateWorkOrderDetail(response, order.id));
      })
      .catch(error => {
        if (!active) return;
        setDetail(null);
        setLoadError(error?.message || 'No se pudo consultar esta orden.');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, dataMode, isOpen, order, revision]);

  useEffect(() => { setActionError(''); }, [order.id]);

  const live = dataMode === 'live' && session?.authenticated === true;
  const roleCode = session?.membership?.roleCode;
  const transitions = !loading && !loadError
    ? availableWorkOrderTransitions(detail, roleCode, session?.user?.id, live)
    : [];
  const assignees = Array.isArray(detail?.WorkOrderAssignees) ? detail.WorkOrderAssignees : [];
  const inputs = Array.isArray(detail?.WorkOrderInputs) ? detail.WorkOrderInputs : [];
  const machinery = Array.isArray(detail?.WorkOrderMachinery) ? detail.WorkOrderMachinery : [];
  const hasExecutionDetails = assignees.length > 0 || inputs.length > 0 || machinery.length > 0;

  const refresh = () => {
    setActionError('');
    setRevision(value => value + 1);
  };

  const doTransition = async (nextStatus) => {
    if (transitioning || !transitions.includes(nextStatus) || !live) return;
    if (nextStatus === 'cancelled' && !window.confirm('¿Cancelar esta orden de trabajo? La acción es definitiva.')) return;
    setTransitioning(true);
    setActionError('');
    try {
      const response = await api.request(`/work-orders/${encodeURIComponent(order.id)}/status`, {
        method: 'PATCH', body: { status: nextStatus }, silent: true
      });
      if (response?.data?.id !== order.id || response?.data?.status !== nextStatus) {
        throw new Error('El servidor no confirmó el nuevo estado. Actualizá el detalle.');
      }
      onUpdated?.();
    } catch (error) {
      // 403/404/409 and transport failures must never display success.
      setActionError(error?.message || 'No se pudo actualizar la orden.');
      setRevision(value => value + 1);
    } finally {
      setTransitioning(false);
    }
  };

  return <Drawer isOpen={isOpen} onClose={onClose} title={detail?.title || order.title}
    footer={transitions.length > 0 && (
      <div className="order-detail__actions" aria-label="Acciones permitidas">
        {transitions.filter(status => status !== 'cancelled').map(status => (
          <button key={status} type="button" className="primary-action"
            disabled={transitioning} onClick={() => void doTransition(status)}>
            <ArrowRight size={15} aria-hidden="true" />
            {WORK_ORDER_STATUS_LABELS[status]}
          </button>
        ))}
        {transitions.includes('cancelled') && <button type="button"
          className="danger-action order-detail__cancel" disabled={transitioning}
          onClick={() => void doTransition('cancelled')}>Cancelar orden</button>}
      </div>
    )}>
    <div className="order-detail">
      {loading ? <p role="status" className="order-detail__notice">Cargando el detalle de la orden…</p>
        : loadError ? <div role="alert" className="order-detail__error">
          <strong>No se pudo abrir esta orden.</strong>
          <p>{loadError}</p>
          <button type="button" className="ghost-action" onClick={refresh}>
            <RefreshCw size={14} aria-hidden="true" /> Reintentar
          </button>
        </div> : detail && <>
          {dataMode === 'mock' && <p className="order-detail__notice" role="status">
            Demostración: este detalle utiliza ejemplos y no permite cambiar estados reales.
          </p>}
          {actionError && <div className="order-detail__error" role="alert">
            <strong>No se actualizó la orden.</strong> {actionError}
          </div>}
          <div className="order-detail__status">
            <span className={`status-badge status-badge--${detail.status}`}>
              {WORK_ORDER_STATUS_LABELS[detail.status]}
            </span>
            <span className={`status-badge status-badge--${PRIORITY_COLOR[detail.priority] || 'gray'}`}>
              {PRIORITY_ES[detail.priority] || 'Sin prioridad'}
            </span>
            <button type="button" className="ghost-action order-detail__refresh"
              disabled={transitioning} onClick={refresh} aria-label="Actualizar orden">
              <RefreshCw size={14} aria-hidden="true" /> Actualizar
            </button>
          </div>
          <section className="detail-section">
            <h3>Resumen</h3>
            <InfoRow icon={MapPin} label="Lote" value={detail.Field?.name} />
            <InfoRow icon={Tag} label="Trabajo" value={TYPE_ES[detail.type] || detail.type} />
            <InfoRow icon={Calendar} label="Vencimiento" value={dateLabel(detail.due_at)} />
            {detail.CampaignField?.campaign_id && <InfoRow icon={Tag} label="Campaña"
              value={detail.CampaignField.campaign_id} />}
            {detail.approved_at && <InfoRow icon={Calendar} label="Aprobada"
              value={dateLabel(detail.approved_at)} />}
            {detail.completed_at && <InfoRow icon={Calendar} label="Completada"
              value={dateLabel(detail.completed_at)} />}
          </section>
          {detail.instructions && <section className="detail-section">
            <h3>Instrucciones</h3>
            <p className="order-detail__instructions">{detail.instructions}</p>
          </section>}
          {detail.status === 'approved' && !assignees.length &&
            ['tenant_admin', 'agronomic_coordinator'].includes(roleCode) && live &&
            <p className="order-detail__notice" role="status">
              Esta orden necesita al menos un responsable antes de marcarla como asignada.
            </p>}
          {hasExecutionDetails && <details className="order-detail__more">
            <summary>Responsables, insumos y maquinaria</summary>
            {assignees.length > 0 && <section className="detail-section">
              <h3>Responsables ({assignees.length})</h3>
              {assignees.map(person => <div className="detail-row" key={person.id}>
                <User size={14} aria-hidden="true" className="order-detail__row-icon" />
                <span className="detail-row__label">{person.responsibility || 'Ejecutor'}</span>
                <span className="detail-row__value">
                  {person.Membership?.User?.full_name || person.user_id || 'No informado'}
                </span>
              </div>)}
            </section>}
            {inputs.length > 0 && <section className="detail-section">
              <h3>Insumos</h3>
              {inputs.map(item => <div className="detail-row" key={item.id}>
                <span className="detail-row__label">
                  {item.AgriculturalInput?.name || 'Insumo'}
                </span>
                <span className="detail-row__value">
                  {item.total_quantity != null ? `Total: ${item.total_quantity}` : ''}
                  {item.dose != null ? ` · Dosis: ${item.dose} ${item.dose_unit || ''}` : ''}
                </span>
              </div>)}
            </section>}
            {machinery.length > 0 && <section className="detail-section">
              <h3>Maquinaria</h3>
              {machinery.map(item => <div className="detail-row" key={item.id}>
                <span className="detail-row__value">{item.Machinery?.name || 'Equipo registrado'}</span>
              </div>)}
            </section>}
          </details>}
          {!transitions.length && live && <p className="order-detail__footnote">
            No hay cambios de estado disponibles para tu rol y el estado actual.
          </p>}
        </>}
    </div>
  </Drawer>;
}
