import { useState } from 'react';
import { useSession } from '../context/SessionContext.jsx';
import { canReportInputs, plannedInputs, validateInputDeclarationPayload,
  validateInputDeclarationResponse } from '../services/inputDeclaration.js';

function formatQuantity(quantity) {
  return quantity == null ? 'No definida' : String(quantity);
}

export function WorkOrderExecutionInputs({ order, report, onChanged }) {
  const { api, dataMode, session } = useSession();
  const live = dataMode === 'live' && session?.authenticated === true;
  const userId = session?.user?.id;
  const plan = plannedInputs(order);
  const declaration = report.input_declaration;
  const canDeclare = canReportInputs(order, report, userId, live);
  const [quantities, setQuantities] = useState({});
  const [notes, setNotes] = useState('');
  const [clientId, setClientId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!live) return null;

  const submit = async event => {
    event.preventDefault();
    if (!canDeclare || busy) return;
    setError('');
    setBusy(true);
    // Retain this UUID after an ambiguous network error; sending an identical
    // retry must not create a duplicate report or alter a committed snapshot.
    const key = clientId || crypto.randomUUID();
    setClientId(key);
    try {
      const payload = validateInputDeclarationPayload(plan, quantities, notes, key);
      const response = await api.request(
        `/work-orders/${encodeURIComponent(order.id)}/executions/${encodeURIComponent(report.id)}/input-declaration`,
        { method: 'POST', body: payload, silent: true });
      validateInputDeclarationResponse(response, order.id, report.id, key);
      onChanged?.();
    } catch (err) {
      setError(err?.message || 'No se confirmó la declaración; podés reintentar con los mismos datos.');
    } finally { setBusy(false); }
  };

  return <section className="order-detail__input-declaration" aria-label="Insumos declarados en el parte">
    <h4>Insumos utilizados (declaración)</h4>
    {plan.length === 0 && <p className="order-detail__footnote">
      Esta orden no tiene insumos planificados. No se presupone consumo ni movimiento de stock.
    </p>}
    {declaration && <>
      <p className="order-detail__notice" role="status">
        Declarado por {declaration.declared_by} · {new Date(declaration.declared_at).toLocaleString('es-AR')}.
        Los valores son informados por una persona, no medidos automáticamente.
      </p>
      <div className="order-detail__input-items">
        {declaration.items.map(item => <div className="order-detail__input-line" key={item.work_order_input_id}>
          <strong>{item.name}</strong>
          <span>Plan: {formatQuantity(item.planned_quantity)} {item.unit}</span>
          <span>Informado: {item.declared_quantity} {item.unit}</span>
          <span>Diferencia informada − plan: {formatQuantity(item.variance_quantity)} {item.unit}</span>
        </div>)}
      </div>
      {declaration.notes && <p>Explicación: {declaration.notes}</p>}
    </>}
    {!declaration && plan.length > 0 && <p className="order-detail__footnote">
      Pendiente de informar cantidades. La coordinación no puede aprobar el parte hasta recibirlas.
    </p>}
    {canDeclare && <form className="order-detail__execution-form" onSubmit={submit}>
      <p>Completá cada insumo planificado. Si no se utilizó, informá <strong>0</strong>.
        Los valores quedan asociados a este parte y no modifican el inventario.</p>
      {plan.map(item => <label key={item.id} className="form-field">
        <span>{item.AgriculturalInput?.name || 'Insumo planificado'} — unidad: {item.AgriculturalInput?.unit || 'Sin definir'}
          {' '}· Plan: {formatQuantity(item.total_quantity)}
        </span>
        <input type="text" inputMode="decimal" required disabled={busy}
          placeholder="Cantidad informada (ej.: 3.5000)"
          value={quantities[item.id] ?? ''}
          onChange={event => setQuantities(current => ({ ...current, [item.id]: event.target.value }))} />
      </label>)}
      <label className="form-field">Explicación de diferencias (obligatoria si hay desvíos)
        <textarea rows={2} maxLength={500} value={notes} disabled={busy}
          placeholder="Aclaraciones sobre diferencias entre la cantidad planificada y la informada"
          onChange={event => setNotes(event.target.value)} />
      </label>
      {error && <p role="alert" className="order-detail__error">{error}</p>}
      <button type="submit" className="primary-action" disabled={busy}>
        {busy ? 'Guardando…' : 'Presentar cantidades informadas'}
      </button>
    </form>}
    {!canDeclare && !declaration && plan.length > 0 &&
      <p className="order-detail__footnote">Solo quien presentó este parte pendiente puede informar los insumos.</p>}
  </section>;
}
