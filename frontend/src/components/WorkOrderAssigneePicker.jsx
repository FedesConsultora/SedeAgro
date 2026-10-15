import { useEffect, useState } from 'react';
import { useSession } from '../context/SessionContext.jsx';
import {
  canManageWorkOrderAssignments, eligibleWorkOrderMembers,
  validateWorkOrderAssignmentResponse
} from '../services/workOrderAssignment.js';

const ROLE_LABELS = {
  tenant_admin: 'Administrador', agronomic_coordinator: 'Coordinación', contractor: 'Contratista'
};

export function WorkOrderAssigneePicker({ order, onAssigned }) {
  const { api, dataMode, session } = useSession();
  const live = dataMode === 'live' && session?.authenticated === true;
  const canManage = canManageWorkOrderAssignments(order, session?.membership?.roleCode, live);
  const [members, setMembers] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [userId, setUserId] = useState('');
  const [saving, setSaving] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!canManage) return undefined;
    let active = true;
    setMembers(null);
    setUserId('');
    setLoadError('');
    setLoading(true);
    api.members().then(response => {
      if (!active) return;
      setMembers(eligibleWorkOrderMembers(response, order.WorkOrderAssignees));
    }).catch(error => {
      if (active) setLoadError(error?.message || 'No se pudo consultar a los responsables.');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, order.id, canManage, revision]);

  if (!canManage) return null;
  const options = (members || []).filter(member =>
    !order.WorkOrderAssignees.some(assignee => assignee.user_id === member.id));

  const assign = async event => {
    event.preventDefault();
    if (saving || loading || loadError || !options.some(member => member.id === userId)) return;
    setSaving(true);
    setActionError('');
    try {
      const response = await api.request(`/work-orders/${encodeURIComponent(order.id)}/assignees`, {
        method: 'POST', body: { user_id: userId, responsibility: 'executor' }, silent: true
      });
      validateWorkOrderAssignmentResponse(response, order.id, userId);
      setUserId('');
      onAssigned?.();
    } catch (error) {
      setActionError(error?.message || 'No fue posible incorporar al responsable.');
    } finally {
      setSaving(false);
    }
  };

  return <section className="detail-section order-detail__assignment">
    <h3>Asignar responsable</h3>
    <p>Elegí un integrante activo de la empresa. Recibirá una notificación de su orden.</p>
    {loading && <p role="status">Consultando responsables autorizados…</p>}
    {loadError && <div className="order-detail__error" role="alert">
      {loadError} <button type="button" className="ghost-action"
        onClick={() => setRevision(value => value + 1)}>Reintentar</button>
    </div>}
    {actionError && <p className="order-detail__error" role="alert">{actionError}</p>}
    {!loading && !loadError && options.length === 0 &&
      <p role="status">No quedan integrantes activos disponibles para asignar.</p>}
    {!loading && !loadError && options.length > 0 && <form onSubmit={assign}>
      <label className="form-field" htmlFor="work-order-new-assignee">
        <span>Responsable *</span>
        <select id="work-order-new-assignee" required value={userId}
          disabled={saving} onChange={event => setUserId(event.target.value)}>
          <option value="">Seleccioná un integrante</option>
          {options.map(member => <option key={member.id} value={member.id}>
            {member.name} — {ROLE_LABELS[member.role] || member.role}
          </option>)}
        </select>
      </label>
      <button type="submit" className="primary-action" disabled={saving || !userId}>
        {saving ? 'Asignando…' : 'Asignar y notificar'}
      </button>
    </form>}
    <p className="order-detail__footnote">
      Al pasar a «Asignada» se cierra la incorporación de responsables. Los cambios posteriores requieren una nueva orden.
    </p>
  </section>;
}
