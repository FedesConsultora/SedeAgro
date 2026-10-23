import { useEffect, useRef, useState } from 'react';
import { useSession } from '../context/SessionContext.jsx';
import { Modal } from './Modal.jsx';
import { ResourceLoadNotice } from './ResourceLoadNotice.jsx';
import { mockData } from '../services/mockData.js';
import {
  createWorkOrderSubmitGate, verifyCreatedWorkOrder, workOrderCreateScope
} from '../services/workOrderCreateSafety.js';

const emptyForm = () => ({
  field_id: '',
  type: 'application',
  priority: 'normal',
  title: '',
  instructions: '',
  due_at: ''
});

export function WorkOrderFormModal({ isOpen, onClose, onCreated }) {
  const { api, dataMode, session } = useSession();
  const authority = workOrderCreateScope(session, dataMode);
  // Render-time fences matter: a fresh tenant/role render may happen before
  // effects clear the previous private list of farm/field names.
  const scopeRef = useRef(authority);
  scopeRef.current = authority;
  const apiRef = useRef(api);
  apiRef.current = api;
  const openRef = useRef(isOpen);
  openRef.current = isOpen;
  const submitGate = useRef(null);
  if (!submitGate.current) submitGate.current = createWorkOrderSubmitGate();

  const [fieldsSnapshot, setFieldsSnapshot] = useState(null);
  const fieldsVisible = fieldsSnapshot?.scope === authority && fieldsSnapshot?.api === api
    ? fieldsSnapshot : null;
  const fields = fieldsVisible?.phase === 'ready' ? fieldsVisible.fields : [];
  const fieldsLoading = Boolean(isOpen && authority && (!fieldsVisible || fieldsVisible.phase === 'loading'));
  const fieldsError = fieldsVisible?.phase === 'error' ? fieldsVisible.error : null;
  const [revision, setRevision] = useState(0);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [submitStatus, setSubmitStatus] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    // Every new modal/authentication context receives a fresh creation gate.
    // No stale response can release the gate of the next tenant or user.
    submitGate.current.reset();
    setForm(emptyForm());
    setSaving(false);
    setSubmitStatus('');
    setError('');
    setFieldsSnapshot(null);
    return () => { submitGate.current.reset(); };
  }, [isOpen, authority, api]);

  useEffect(() => {
    if (!isOpen || !authority) return undefined;
    let active = true;
    const scope = authority;
    const requestApi = api;
    const current = () => active && openRef.current &&
      scopeRef.current === scope && apiRef.current === requestApi;
    setFieldsSnapshot({ scope, api: requestApi, phase: 'loading', fields: [], error: null });
    const load = async () => {
      try {
        const response = dataMode === 'mock'
          ? { data: mockData.fields }
          : await requestApi.fields();
        if (!Array.isArray(response?.data)) throw new Error('Lista de lotes inválida.');
        if (current()) setFieldsSnapshot({
          scope, api: requestApi, phase: 'ready', fields: response.data, error: null
        });
      } catch (err) {
        if (current()) setFieldsSnapshot({
          scope, api: requestApi, phase: 'error', fields: [],
          error: err?.message || 'No se pudieron consultar los lotes.'
        });
      }
    };
    void load();
    return () => { active = false; };
  }, [isOpen, authority, api, dataMode, revision]);

  const set = (key) => (event) =>
    setForm((previous) => ({ ...previous, [key]: event.target.value }));

  const safeClose = () => {
    // A POST may have committed even if the connection later fails. Don't let
    // overlay/Escape close a modal while a non-idempotent POST is in flight.
    if (submitGate.current.isPending(authority)) return;
    onClose?.();
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!isOpen || !authority || fieldsLoading || fieldsError ||
        !fields.some(field => field.id === form.field_id) ||
        form.title.trim().length < 2) return;
    const body = { ...form, due_at: form.due_at || undefined };
    const requestApi = api;
    const ticket = submitGate.current.acquire(authority);
    if (!ticket) return; // synchronous guard against two events before render
    const current = () => openRef.current && scopeRef.current === authority &&
      apiRef.current === requestApi && submitGate.current.isCurrent(ticket);
    setSaving(true);
    setError('');
    let transmitted = false;
    let created = false;
    try {
      if (dataMode === 'mock') {
        created = true;
      } else {
        transmitted = true;
        const response = await requestApi.createWorkOrder(body);
        if (!current()) return;
        verifyCreatedWorkOrder(response, body, session?.user?.id);
        created = true;
      }
      if (!current()) return;
      submitGate.current.finish(ticket, 'confirmed');
      setSubmitStatus('confirmed');
    } catch (err) {
      if (!current()) return;
      // No creation idempotency key exists in the current work-order API.
      // Even a 500 or lost ACK may follow a committed insert: never POST
      // again from this form. The operator must inspect the order list first.
      submitGate.current.finish(ticket, transmitted ? 'uncertain' : 'preflight-rejected');
      setSubmitStatus(transmitted ? 'uncertain' : '');
      setError(transmitted
        ? 'No se pudo confirmar si la orden quedó creada. Cerrá este formulario, actualizá la lista de órdenes y revisá antes de intentar crear otra.'
        : err?.message || 'No se pudo preparar la orden.');
    } finally {
      if (current()) setSaving(false);
    }
    if (created && current()) onCreated?.();
  };

  const blocked = saving || submitStatus !== '' ||
    submitGate.current.isBlocked(authority);
  const editable = !blocked && Boolean(authority);
  return (
    <Modal isOpen={isOpen} onClose={safeClose} title="Nueva orden de trabajo"
      footer={<>
        <button type="button" className="ghost-action" onClick={safeClose}
          disabled={saving}>Cancelar</button>
        <button type="submit" form="wo-form" className="primary-action"
          disabled={!editable || fieldsLoading || Boolean(fieldsError) || fields.length === 0}>
          {saving ? 'Guardando…' : submitStatus === 'uncertain'
            ? 'Confirmación pendiente' : 'Crear orden'}
        </button>
      </>}>
      <form id="wo-form" onSubmit={handleSubmit} style={{ display: 'contents' }}>
        {!authority && dataMode === 'live' &&
          <div className="auth-error" role="alert">Tu sesión no permite crear órdenes de trabajo.</div>}
        {fieldsLoading && <p role="status">Cargando lotes autorizados…</p>}
        {fieldsError && <ResourceLoadNotice title="lotes de la orden" error={fieldsError}
          onRetry={() => setRevision(value => value + 1)} />}
        {!fieldsLoading && !fieldsError && fields.length === 0 &&
          <p role="status">No hay lotes disponibles. Registrá un lote antes de crear la orden.</p>}
        {error && <div className="auth-error" role="alert"><span>{error}</span></div>}

        <label className="form-field">
          <span>Título de la orden *</span>
          <input id="wo-title" value={form.title} onChange={set('title')}
            disabled={!editable} required minLength={3} maxLength={180}
            placeholder="Aplicación selectiva lote 4" />
        </label>
        <label className="form-field">
          <span>Lote *</span>
          <select id="wo-field" value={form.field_id} onChange={set('field_id')}
            disabled={!editable || fieldsLoading || Boolean(fieldsError)} required>
            <option value="">Seleccioná un lote</option>
            {fields.map((field) => (
              <option key={field.id} value={field.id}>
                {field.name} {field.Farm ? `— ${field.Farm.name}` : ''}
              </option>
            ))}
          </select>
        </label>

        <div className="form-row">
          <label className="form-field">
            <span>Tipo de tarea *</span>
            <select id="wo-type" value={form.type} onChange={set('type')} disabled={!editable}>
              <option value="application">Aplicación</option>
              <option value="sowing">Siembra</option>
              <option value="fertilization">Fertilización</option>
              <option value="harvest">Cosecha</option>
              <option value="irrigation">Riego</option>
              <option value="inspection">Inspección</option>
              <option value="other">Otro</option>
            </select>
          </label>
          <label className="form-field">
            <span>Prioridad</span>
            <select id="wo-priority" value={form.priority} onChange={set('priority')} disabled={!editable}>
              <option value="low">Baja</option>
              <option value="normal">Normal</option>
              <option value="high">Alta</option>
              <option value="urgent">Urgente</option>
            </select>
          </label>
        </div>

        <label className="form-field">
          <span>Fecha límite</span>
          <input id="wo-due" type="datetime-local" value={form.due_at}
            onChange={set('due_at')} disabled={!editable} />
        </label>
        <label className="form-field">
          <span>Instrucciones</span>
          <textarea id="wo-instructions" value={form.instructions}
            onChange={set('instructions')} disabled={!editable} rows={3}
            placeholder="Controlar cabecera norte y registrar evidencia fotográfica…" />
        </label>
      </form>
    </Modal>
  );
}
