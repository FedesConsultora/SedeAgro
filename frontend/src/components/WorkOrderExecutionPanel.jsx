import { useCallback, useRef, useState } from 'react';
import { useSession } from '../context/SessionContext.jsx';
import { WorkOrderExecutionEvidence } from './WorkOrderExecutionEvidence.jsx';
import { WorkOrderExecutionInputs } from './WorkOrderExecutionInputs.jsx';
import { WorkOrderExecutionExceptions } from './WorkOrderExecutionExceptions.jsx';
import { exceptionReadinessForReview } from '../services/executionReviewReadiness.js';
import { hasPlannedInputsWithoutDeclaration } from '../services/inputDeclaration.js';
import { needsExecutionReceiptLookup, reconcileExecutionReceipt } from '../services/workOrderExecutionReceipt.js';
import { needsReviewReceiptLookup, reconcileReviewReceipt } from '../services/workOrderReviewReceipt.js';
import { buildVerifiedReviewChecklist, operationReviewLabel, reviewChecklistOutcome,
  ORDER_TYPES_WITH_REQUIRED_EVIDENCE } from '../services/reviewChecklist.js';
import {
  executionReports, canDeclareExecution, canReviewExecutionReport,
  buildExecutionDraft, validatedExecutionResponse
} from '../services/workOrderExecution.js';

const REVIEW_LABELS = { submitted: 'Declarado — pendiente de revisión',
  verified: 'Revisado por coordinación', rejected: 'Rechazado — requiere nuevo parte' };
const localDate = value => {
  if (!value) return 'Sin fecha';
  const dt = new Date(value);
  return Number.isFinite(dt.getTime()) ? dt.toLocaleString('es-AR') : 'Fecha inválida';
};

export function WorkOrderExecutionPanel({ order, onChanged }) {
  const { api, dataMode, session } = useSession();
  const live = dataMode === 'live' && session?.authenticated === true;
  const role = session?.membership?.roleCode;
  const userId = session?.user?.id;
  const reports = executionReports(order);
  const canSubmit = canDeclareExecution(order, role, userId, live);
  const [started, setStarted] = useState('');
  const [finished, setFinished] = useState('');
  const [area, setArea] = useState('');
  const [outcome, setOutcome] = useState('');
  const [attest, setAttest] = useState(false);
  const [reviewReason, setReviewReason] = useState({});
  const [reviewChecks, setReviewChecks] = useState({});
  const [exceptionReadiness, setExceptionReadiness] = useState(null);
  const onReadinessChanged = useCallback(next => setExceptionReadiness(next), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pendingPayload, setPendingPayload] = useState(null);
  const [pendingReview, setPendingReview] = useState(null);
  const reviewInFlight = useRef(false);

  if (!live) return null;

  // Never retry the POST automatically. GET is performed under the current
  // cookie, membership, tenant and backend orders.read policy.
  const verifyInterruptedSubmission = async payload => {
    try {
      const response = await api.request(`/work-orders/${encodeURIComponent(order.id)}`, {
        silent: true
      });
      const outcome = reconcileExecutionReceipt(response, {
        orderId: order.id, actorId: userId, payload
      });
      if (outcome.state === 'recorded') {
        setPendingPayload(null);
        setError('');
        setNotice('El servidor registra un parte coincidente de tu usuario. Se actualizará la orden; no se volvió a enviar.');
        onChanged?.();
      } else if (outcome.state === 'different') {
        setError('El servidor registra otro parte activo. No se volvió a enviar; actualizá la orden antes de continuar.');
        onChanged?.();
      } else if (outcome.state === 'ambiguous') {
        setError('Hay varios partes coincidentes en el historial. Solicitá revisión a coordinación antes de intentar otro envío.');
      } else {
        setError('El servidor aún no confirma este parte. No se volvió a enviar; comprobá nuevamente con conexión estable antes de salir del formulario.');
      }
    } catch {
      setError('No se pudo comprobar el parte en el servidor. El envío podría haberse guardado: no lo repitas sin verificar.');
    }
  };

  const submit = async event => {
    event.preventDefault();
    if (!canSubmit || !attest || busy || pendingPayload) return;
    let body;
    try {
      body = buildExecutionDraft({
        started, finished, area, outcome, approvedAt: order.approved_at
      });
    } catch (err) {
      setError(err?.message || 'Revisá los datos declarados.');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await api.request(`/work-orders/${encodeURIComponent(order.id)}/executions`, {
        method: 'POST', silent: true, body
      });
      validatedExecutionResponse(response, order.id, 'submitted');
      onChanged?.();
    } catch (err) {
      if (needsExecutionReceiptLookup(err)) {
        setPendingPayload(body);
        await verifyInterruptedSubmission(body);
      } else {
        setError(err?.message || 'No se guardó el parte de ejecución.');
      }
    } finally {
      setBusy(false);
    }
  };

  const recheckReceipt = async () => {
    if (!pendingPayload || busy) return;
    setBusy(true);
    setError('');
    try {
      await verifyInterruptedSubmission(pendingPayload);
    } finally {
      setBusy(false);
    }
  };

  // A prior review may have COMMITTED before its HTTP ACK was lost.
  // Never issue another POST as a recovery action: inspect its exact server row.
  const verifyInterruptedReview = async pending => {
    try {
      const response = await api.request(`/work-orders/${encodeURIComponent(order.id)}`, {
        silent: true
      });
      const receipt = reconcileReviewReceipt(response, {
        orderId: order.id, reportId: pending.reportId, reviewerId: userId,
        ...pending.body
      });
      if (receipt.state === 'recorded') {
        setPendingReview(null);
        setError('');
        setNotice('La revisión figura registrada por tu usuario en el servidor. No se volvió a enviar.');
        onChanged?.();
      } else if (receipt.state === 'different') {
        setError('El servidor registra una revisión distinta. No se volvió a enviar; actualizá la orden y consultá con coordinación.');
        onChanged?.();
      } else {
        setError('El servidor aún no confirma la revisión. Podés comprobar nuevamente o reintentar explícitamente la misma decisión con su clave original.');
      }
    } catch {
      setError('No se pudo comprobar la revisión. Podría haberse guardado; no la repitas sin verificar el estado del servidor.');
    }
  };

  const recheckReview = async () => {
    if (!pendingReview || busy) return;
    setBusy(true);
    setError('');
    try {
      await verifyInterruptedReview(pendingReview);
    } finally {
      setBusy(false);
    }
  };

  const retryOriginalReview = async () => {
    if (!pendingReview || busy || reviewInFlight.current ||
        !pendingReview.body.client_request_id) return;
    // The durable key is identical: the server can return the original
    // receipt after a committed/lost ACK, never create a second audit event.
    reviewInFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const response = await api.request(
        `/work-orders/${encodeURIComponent(order.id)}/executions/${encodeURIComponent(pendingReview.reportId)}/review`, {
          method: 'POST', silent: true, body: pendingReview.body
        });
      validatedExecutionResponse(response, order.id,
        pendingReview.body.decision, pendingReview.reportId);
      setPendingReview(null);
      setNotice(response.replayed === true
        ? 'El servidor confirmó la revisión original, sin duplicarla.'
        : 'El servidor confirmó la revisión. No se generó otra decisión.');
      onChanged?.();
    } catch (err) {
      if (needsReviewReceiptLookup(err)) {
        await verifyInterruptedReview(pendingReview);
      } else {
        setError(err?.message || 'No fue posible recuperar la revisión original.');
      }
    } finally {
      reviewInFlight.current = false;
      setBusy(false);
    }
  };

  const review = async (report, decision) => {
    if (!canReviewExecutionReport(order, report, role, userId, live) || busy || pendingReview || reviewInFlight.current) return;
    if (decision === 'verified') {
      const readiness = exceptionReadinessForReview(order, report, exceptionReadiness);
      if (!readiness.allowed) {
        setError(readiness.reason);
        return;
      }
    }
    let checklist;
    try {
      if (decision === 'verified') {
        checklist = buildVerifiedReviewChecklist(reviewChecks[report.id], order.type);
        if (!window.confirm('¿Confirmás los controles indicados? Esto es revisión administrativa, no certificación física.')) return;
      }
    } catch (err) {
      setError(err?.message || 'Faltan controles de revisión.');
      return;
    }
    const reason = reviewReason[report.id]?.trim();
    if (decision === 'rejected' && (!reason || reason.length < 10)) {
      setError('Para rechazar, explicá el motivo con al menos 10 caracteres.');
      return;
    }
    // Generated once for this human decision. Every explicit retry of an
    // uncertain delivery must reuse this exact UUID and immutable body.
    const body = { client_request_id: crypto.randomUUID(),
      decision, ...(decision === 'rejected' ? { reason } : { checklist }) };
    // React state updates are asynchronous: guard two clicks in the same tick.
    reviewInFlight.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await api.request(
        `/work-orders/${encodeURIComponent(order.id)}/executions/${encodeURIComponent(report.id)}/review`, {
          method: 'POST', silent: true, body
        });
      validatedExecutionResponse(response, order.id, decision, report.id);
      onChanged?.();
    } catch (err) {
      if (needsReviewReceiptLookup(err)) {
        const pending = { reportId: report.id, body };
        setPendingReview(pending);
        await verifyInterruptedReview(pending);
      } else {
        setError(err?.message || 'No se confirmó la revisión.');
      }
    } finally {
      reviewInFlight.current = false;
      setBusy(false);
    }
  };

  return <section className="detail-section order-detail__execution">
    <h3>Parte de ejecución</h3>
    <p>Los datos son <strong>declarados por el responsable</strong>. Una revisión independiente
      permite cerrar administrativamente la orden; no constituye una medición automática.</p>
    {notice && <p className="order-detail__notice" role="status">{notice}</p>}
    {error && <div className="order-detail__error" role="alert">
      {error} <button type="button" className="ghost-action"
        onClick={onChanged}>Actualizar datos</button>
      {pendingReview && <button type="button" className="ghost-action"
        disabled={busy} onClick={() => void recheckReview()}>
        {busy ? 'Comprobando…' : 'Comprobar revisión en servidor'}
      </button>}
      {pendingReview?.body.client_request_id && <button type="button"
        className="ghost-action" disabled={busy}
        onClick={() => void retryOriginalReview()}>
        Reintentar revisión con la misma clave
      </button>}
      {pendingPayload && <button type="button" className="ghost-action"
        disabled={busy} onClick={() => void recheckReceipt()}>
        {busy ? 'Comprobando…' : 'Comprobar parte en servidor'}
      </button>}
    </div>}
    {canSubmit && <form className="order-detail__execution-form" onSubmit={submit}>
      <p className="order-detail__footnote">
        Indicá fechas posteriores a la aprobación y la superficie efectivamente trabajada.
        El dispositivo muestra horas locales; el servidor comprueba el intervalo antes de guardar.
      </p>
      <label className="form-field">Inicio real informado *
        <input type="datetime-local" required value={started} disabled={busy}
          onChange={e => setStarted(e.target.value)} />
      </label>
      <label className="form-field">Finalización real informada *
        <input type="datetime-local" required value={finished} disabled={busy}
          onChange={e => setFinished(e.target.value)} />
      </label>
      <label className="form-field">Superficie declarada (ha) *
        <input type="number" required min="0.01" max="1000000" step="0.01"
          value={area} disabled={busy} onChange={e => setArea(e.target.value)} />
      </label>
      <label className="form-field">Resultado observado *
        <textarea required minLength={10} maxLength={2000} rows={3}
          placeholder="Describí qué se hizo, resultado y cualquier desvío observado."
          value={outcome} disabled={busy} onChange={e => setOutcome(e.target.value)} />
      </label>
      <label className="order-detail__execution-consent">
        <input type="checkbox" checked={attest} disabled={busy}
          onChange={e => setAttest(e.target.checked)} />
        Declaro que la información ingresada corresponde al trabajo que informo.
      </label>
      <button type="submit" className="primary-action" disabled={!attest || busy || Boolean(pendingPayload) || !started || !finished || !area || outcome.trim().length < 10}>
        {busy ? 'Enviando…' : 'Presentar parte para revisión'}
      </button>
    </form>}
    {order.status === 'in_progress' && !canSubmit && !reports.some(item => ['submitted', 'verified'].includes(item.review_status)) &&
      <p className="order-detail__footnote">La presentación del parte requiere un responsable autorizado.</p>}
    {reports.length === 0 && <p className="order-detail__footnote">
      Todavía no hay partes de ejecución. No se puede certificar el trabajo mediante un cambio de estado.
    </p>}
    {reports.map(report => <article key={report.id} className="order-detail__execution-record">
      <strong>{REVIEW_LABELS[report.review_status] || 'Estado desconocido'}</strong>
      <p>Informado por {report.submitted_by} · {localDate(report.created_at)}</p>
      <p>Trabajo declarado: {localDate(report.started_at)} → {localDate(report.finished_at)}</p>
      <p>Superficie informada: {report.worked_area_hectares} ha</p>
      <p className="order-detail__instructions">{report.result_summary}</p>
      <WorkOrderExecutionInputs order={order} report={report} onChanged={onChanged} />
      {report.reviewed_at && <p>Revisado por {report.reviewed_by} · {localDate(report.reviewed_at)}</p>}
      {report.review_status === 'rejected' && <p>Motivo: {report.review_note}</p>}
      {reviewChecklistOutcome(report) && <p className="order-detail__notice" role="status">
        Revisión estructurada registrada: fechas, superficie, resultado y operación contrastados.
        {report.review_checklist.evidence_basis === 'reviewed_files'
          ? ' La persona revisora declaró haber examinado los adjuntos.'
          : ' Se dejó constancia expresa de ausencia de archivos.'}
      </p>}
      {report.review_status === 'verified' && !reviewChecklistOutcome(report) &&
        <p className="order-detail__footnote">Revisión histórica, sin checklist estructurado; no se infieren controles retroactivos.</p>}
      {canReviewExecutionReport(order, report, role, userId, live) && <div className="order-detail__execution-review">
        <fieldset className="order-detail__review-checklist" disabled={busy || Boolean(pendingReview)}>
          <legend>Controles de revisión para {order.type} (solo aceptación)</legend>
          {[
            ['time_checked', 'Contrasté las fechas y horas declaradas.'],
            ['area_checked', 'Contrasté la superficie declarada.'],
            ['result_checked', 'Leí y contrasté el resultado informado.'],
            ['operation_checked', operationReviewLabel(order.type)]
          ].map(([key, label]) => <label key={key} className="order-detail__execution-consent">
            <input type="checkbox" checked={reviewChecks[report.id]?.[key] === true}
              onChange={event => setReviewChecks(current => ({
                ...current, [report.id]: { ...current[report.id], [key]: event.target.checked }
              }))} />
            {label}
          </label>)}
          <label className="form-field">Situación del respaldo documental
            <select value={reviewChecks[report.id]?.evidence_basis || ''} onChange={event =>
              setReviewChecks(current => ({ ...current,
                [report.id]: { ...current[report.id], evidence_basis: event.target.value } }))}>
              <option value="">Seleccioná una opción</option>
              <option value="reviewed_files">Examiné archivos adjuntos a este parte</option>
              {!ORDER_TYPES_WITH_REQUIRED_EVIDENCE.includes(order.type) &&
                <option value="no_files">No hay archivos; acepto dejando constancia de su ausencia</option>}
            </select>
          </label>
          {ORDER_TYPES_WITH_REQUIRED_EVIDENCE.includes(order.type) && <p className="order-detail__footnote">
            Aplicación/fertilización: el servidor exige al menos un archivo privado íntegro.
          </p>}
          <p className="order-detail__footnote">
            Revisión declarada por coordinación; no acredita por sí misma la ejecución física.
          </p>
        </fieldset>
        <label className="form-field">Motivo de rechazo (obligatorio solo si rechazás)
          <textarea maxLength={500} rows={2} value={reviewReason[report.id] || ''}
            disabled={busy || Boolean(pendingReview)} onChange={e => setReviewReason(current => ({ ...current, [report.id]: e.target.value }))} />
        </label>
        {!exceptionReadinessForReview(order, report, exceptionReadiness).allowed &&
          <p className="order-detail__footnote" role="status">
            {exceptionReadinessForReview(order, report, exceptionReadiness).reason}
          </p>}
        <div className="order-detail__execution-actions">
          <button className="primary-action" type="button"
            disabled={busy || Boolean(pendingReview) || hasPlannedInputsWithoutDeclaration(order, report) ||
              !exceptionReadinessForReview(order, report, exceptionReadiness).allowed}
            onClick={() => void review(report, 'verified')}>Aceptar revisión</button>
          <button className="ghost-action" type="button" disabled={busy || Boolean(pendingReview)}
            onClick={() => void review(report, 'rejected')}>Rechazar parte</button>
        </div>
      </div>}
    </article>)}
    <WorkOrderExecutionEvidence order={order} reports={reports} onChanged={onChanged} />
    <WorkOrderExecutionExceptions order={order} reports={reports}
      onChanged={onChanged} onReadinessChanged={onReadinessChanged} />
    {reports.some(item => item.review_status === 'verified') &&
      <p role="status" className="order-detail__notice">
        Existe un parte revisado; la coordinación puede completar administrativamente la orden.
      </p>}
  </section>;
}
