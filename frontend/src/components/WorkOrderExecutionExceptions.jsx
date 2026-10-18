import { useEffect, useState } from 'react';
import { reportSignature } from '../services/executionReviewReadiness.js';
import { useSession } from '../context/SessionContext.jsx';
import {
  exceptionsForReport, canProposeException, canReviewExceptionUI,
  makeExceptionPayload, confirmException, MAX_UNPLANNED_INPUTS
} from '../services/inputException.js';

const LABELS = {
  submitted: 'Pendiente de coordinación',
  approved: 'Excepción aprobada por coordinación',
  rejected: 'Excepción rechazada — corresponde presentar un nuevo parte'
};

export function WorkOrderExecutionExceptions({ order, reports, onChanged, onReadinessChanged }) {
  const { api, dataMode, session } = useSession();
  const live = dataMode === 'live' && session?.authenticated === true;
  const userId = session?.user?.id;
  const role = session?.membership?.roleCode;
  const [items, setItems] = useState([]);
  const [options, setOptions] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [activeReportId, setActiveReportId] = useState(null);
  const [inputId, setInputId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [requestId, setRequestId] = useState('');
  const [reviewReasons, setReviewReasons] = useState({});
  const [busy, setBusy] = useState(false);
  const canOffer = reports.some(report => canProposeException(order, report, userId, live));
  const signature = reportSignature(reports);

  useEffect(() => {
    if (!live || reports.length === 0) return undefined;
    let active = true;
    setItems([]);
    setLoaded(false);
    setError('');
    onReadinessChanged?.({ orderId: order.id, reportSignature: signature, phase: 'loading', items: [] });
    api.request(`/work-orders/${encodeURIComponent(order.id)}/execution-exceptions`, { silent: true })
      .then(response => {
        if (!Array.isArray(response?.data) || !response.data.every(item =>
          typeof item?.id === 'string' &&
          reports.some(report => report.id === item.work_order_execution_id))) {
          throw new Error('El servidor devolvió excepciones inválidas para esta orden.');
        }
        if (active) {
          setItems(response.data);
          onReadinessChanged?.({ orderId: order.id, reportSignature: signature,
            phase: 'ready', items: response.data });
        }
      })
      .catch(err => {
        if (active) {
          setError(err?.message || 'No se pudieron consultar las excepciones.');
          onReadinessChanged?.({ orderId: order.id, reportSignature: signature, phase: 'error', items: [] });
        }
      })
      .finally(() => { if (active) setLoaded(true); });
    return () => { active = false; };
  }, [api, live, order.id, reports, signature, revision, userId, onReadinessChanged]);

  useEffect(() => {
    if (!canOffer || !live) return undefined;
    let active = true;
    setOptions([]);
    api.request(`/work-orders/${encodeURIComponent(order.id)}/unplanned-input-options`, { silent: true })
      .then(response => {
        if (!Array.isArray(response?.data) || !response.data.every(item =>
          typeof item?.id === 'string' && typeof item.name === 'string' &&
          typeof item.unit === 'string')) throw new Error('Catálogo de insumos inválido.');
        if (active) setOptions(response.data);
      })
      .catch(err => { if (active) setError(err?.message || 'No se pudo consultar el catálogo.'); });
    return () => { active = false; };
  }, [api, canOffer, live, order.id, userId]);

  if (!live || reports.length === 0) return null;

  const openForm = reportId => {
    setActiveReportId(reportId);
    setInputId('');
    setQuantity('');
    setReason('');
    setRequestId(crypto.randomUUID());
    setError('');
  };
  const submit = async event => {
    event.preventDefault();
    if (busy || !activeReportId || !loaded) return;
    setBusy(true);
    setError('');
    // A pending write may already have committed after a network timeout.
    // Do not let coordination approve from an old, previously valid snapshot.
    onReadinessChanged?.({ orderId: order.id, reportSignature: signature, phase: 'loading', items: [] });
    try {
      const body = makeExceptionPayload(options, inputId, quantity, reason, requestId);
      const response = await api.request(
        `/work-orders/${encodeURIComponent(order.id)}/executions/${encodeURIComponent(activeReportId)}/exceptions`,
        { method: 'POST', body, silent: true });
      confirmException(response, activeReportId, inputId);
      setActiveReportId(null);
      setRevision(n => n + 1);
      onChanged?.();
    } catch (err) {
      // The same UUID and inputs remain for a network-ambiguous retry.
      setError(err?.message || 'No se confirmó la excepción. Podés reintentar.');
      onReadinessChanged?.({ orderId: order.id, reportSignature: signature, phase: 'error', items: [] });
    } finally { setBusy(false); }
  };

  const review = async (report, item, decision) => {
    if (busy || !canReviewExceptionUI(order, report, item, role, userId, live)) return;
    const note = (reviewReasons[item.id] || '').trim();
    if (decision === 'rejected' && note.length < 10) {
      setError('Indicá el motivo de rechazo (mínimo 10 caracteres).');
      return;
    }
    if (decision === 'approved' && !window.confirm(
      '¿Aprobás administrativamente esta excepción de insumo no previsto? Esto no acredita consumo físico.')) return;
    setBusy(true);
    setError('');
    onReadinessChanged?.({ orderId: order.id, reportSignature: signature, phase: 'loading', items: [] });
    try {
      const response = await api.request(
        `/work-orders/${encodeURIComponent(order.id)}/executions/${encodeURIComponent(report.id)}/exceptions/${encodeURIComponent(item.id)}/review`,
        { method: 'POST', silent: true,
          body: { decision, ...(decision === 'rejected' ? { reason: note } : {}) } });
      const updated = confirmException(response, report.id, item.input_id);
      if (updated.id !== item.id || updated.review_status !== decision) {
        throw new Error('El servidor no confirmó esta decisión.');
      }
      setRevision(n => n + 1);
      onChanged?.();
    } catch (err) {
      setError(err?.message || 'No se confirmó la revisión.');
      onReadinessChanged?.({ orderId: order.id, reportSignature: signature, phase: 'error', items: [] });
    } finally { setBusy(false); }
  };

  return <section className="detail-section order-detail__exceptions">
    <h3>Insumos no previstos y supervisión</h3>
    <p>Registrá únicamente situaciones declaradas y justificadas; no se descuenta stock.
      Una excepción pendiente o rechazada bloquea la aceptación del parte.</p>
    {!loaded && <p role="status">Consultando excepciones del servidor…</p>}
    {error && <div role="alert" className="order-detail__error">
      {error} <button type="button" className="ghost-action" onClick={() => setRevision(n => n + 1)}>
        Reintentar consulta
      </button>
    </div>}
    {reports.map(report => {
      const linked = exceptionsForReport(items, report.id);
      const canAdd = loaded && !error && canProposeException(order, report, userId, live, linked.length) &&
        options.length > 0;
      const plannedIds = new Set((order.WorkOrderInputs || []).map(line => line.input_id));
      const takenIds = new Set(linked.map(item => item.input_id));
      const available = options.filter(option => !plannedIds.has(option.id) && !takenIds.has(option.id));
      return <div key={report.id} className="order-detail__execution-record">
        <strong>Parte {report.id.slice(0, 8)}… — excepciones: {linked.length}/{MAX_UNPLANNED_INPUTS}</strong>
        {loaded && !error && linked.length === 0 && <p>Sin insumos no previstos declarados.</p>}
        {linked.map(item => <article key={item.id} className="order-detail__input-line">
          <strong>{item.input_name}</strong>
          <span>Informado: {item.quantity} {item.unit}</span>
          <p>Motivo informado: {item.reason}</p>
          <p role="status">{LABELS[item.review_status] || 'Estado desconocido'}</p>
          {item.reviewed_by && <p>Revisor: {item.reviewed_by} · {item.review_note || 'Sin observación de rechazo'}</p>}
          {canReviewExceptionUI(order, report, item, role, userId, live) &&
            <div className="order-detail__execution-review">
              <label className="form-field">Motivo si rechazás la excepción
                <textarea rows={2} maxLength={500} value={reviewReasons[item.id] || ''}
                  disabled={busy} onChange={event => setReviewReasons(current => ({
                    ...current, [item.id]: event.target.value }))} />
              </label>
              <div className="order-detail__execution-actions">
                <button type="button" className="primary-action" disabled={busy}
                  onClick={() => void review(report, item, 'approved')}>Aprobar excepción</button>
                <button type="button" className="ghost-action" disabled={busy}
                  onClick={() => void review(report, item, 'rejected')}>Rechazar excepción</button>
              </div>
            </div>}
        </article>)}
        {canAdd && available.length > 0 && <button type="button" className="ghost-action"
          disabled={busy} onClick={() => openForm(report.id)}>Declarar insumo no previsto</button>}
        {activeReportId === report.id && canAdd && <form className="order-detail__execution-form"
          onSubmit={submit}>
          <label className="form-field">Insumo del catálogo de esta empresa
            <select required disabled={busy} value={inputId} onChange={event => setInputId(event.target.value)}>
              <option value="">Seleccioná un insumo no planificado</option>
              {available.map(option => <option key={option.id} value={option.id}>
                {option.name} ({option.unit})
              </option>)}
            </select>
          </label>
          <label className="form-field">Cantidad informada (unidad del catálogo)
            <input required type="text" inputMode="decimal" disabled={busy}
              value={quantity} placeholder="Ej.: 0.7500"
              onChange={event => setQuantity(event.target.value)} />
          </label>
          <label className="form-field">Motivo de utilización no planificada
            <textarea required minLength={10} maxLength={500} rows={2} disabled={busy}
              value={reason} onChange={event => setReason(event.target.value)} />
          </label>
          <div className="order-detail__execution-actions">
            <button type="submit" className="primary-action" disabled={busy}>
              {busy ? 'Registrando…' : 'Presentar excepción'}
            </button>
            <button type="button" className="ghost-action" disabled={busy}
              onClick={() => setActiveReportId(null)}>Cancelar</button>
          </div>
        </form>}
      </div>;
    })}
  </section>;
}
