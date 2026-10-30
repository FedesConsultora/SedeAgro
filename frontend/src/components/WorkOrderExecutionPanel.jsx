import { useCallback, useState } from 'react';
import { useSession } from '../context/SessionContext.jsx';
import { WorkOrderExecutionEvidence } from './WorkOrderExecutionEvidence.jsx';
import { WorkOrderExecutionInputs } from './WorkOrderExecutionInputs.jsx';
import { WorkOrderExecutionExceptions } from './WorkOrderExecutionExceptions.jsx';
import { exceptionReadinessForReview } from '../services/executionReviewReadiness.js';
import { hasPlannedInputsWithoutDeclaration } from '../services/inputDeclaration.js';
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

  if (!live) return null;

  const submit = async event => {
    event.preventDefault();
    if (!canSubmit || !attest || busy) return;
    setBusy(true);
    setError('');
    try {
      const body = buildExecutionDraft({
        started, finished, area, outcome, approvedAt: order.approved_at
      });
      const response = await api.request(`/work-orders/${encodeURIComponent(order.id)}/executions`, {
        method: 'POST', silent: true, body
      });
      validatedExecutionResponse(response, order.id, 'submitted');
      onChanged?.();
    } catch (err) {
      setError(err?.message || 'No se guardó el parte de ejecución.');
    } finally {
      setBusy(false);
    }
  };

  const review = async (report, decision) => {
    if (!canReviewExecutionReport(order, report, role, userId, live) || busy) return;
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
    setBusy(true);
    setError('');
    try {
      const response = await api.request(
        `/work-orders/${encodeURIComponent(order.id)}/executions/${encodeURIComponent(report.id)}/review`, {
          method: 'POST', silent: true,
          body: { decision, ...(decision === 'rejected' ? { reason } : { checklist }) }
        });
      validatedExecutionResponse(response, order.id, decision, report.id);
      onChanged?.();
    } catch (err) {
      setError(err?.message || 'No se confirmó la revisión.');
    } finally {
      setBusy(false);
    }
  };

  return <section className="detail-section order-detail__execution">
    <h3>Parte de ejecución</h3>
    <p>Los datos son <strong>declarados por el responsable</strong>. Una revisión independiente
      permite cerrar administrativamente la orden; no constituye una medición automática.</p>
    {error && <div className="order-detail__error" role="alert">
      {error} <button type="button" className="ghost-action"
        onClick={onChanged}>Actualizar datos</button>
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
      <button type="submit" className="primary-action" disabled={!attest || busy || !started || !finished || !area || outcome.trim().length < 10}>
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
        <fieldset className="order-detail__review-checklist" disabled={busy}>
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
            disabled={busy} onChange={e => setReviewReason(current => ({ ...current, [report.id]: e.target.value }))} />
        </label>
        {!exceptionReadinessForReview(order, report, exceptionReadiness).allowed &&
          <p className="order-detail__footnote" role="status">
            {exceptionReadinessForReview(order, report, exceptionReadiness).reason}
          </p>}
        <div className="order-detail__execution-actions">
          <button className="primary-action" type="button"
            disabled={busy || hasPlannedInputsWithoutDeclaration(order, report) ||
              !exceptionReadinessForReview(order, report, exceptionReadiness).allowed}
            onClick={() => void review(report, 'verified')}>Aceptar revisión</button>
          <button className="ghost-action" type="button" disabled={busy}
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
