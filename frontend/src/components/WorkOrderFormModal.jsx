import { useEffect, useRef, useState } from 'react';
import { useSession } from '../context/SessionContext.jsx';
import { Modal } from './Modal.jsx';
import { ResourceLoadNotice } from './ResourceLoadNotice.jsx';
import { mockData } from '../services/mockData.js';
import {
  createWorkOrderSubmitGate, verifyCreatedWorkOrder, workOrderCreateScope
} from '../services/workOrderCreateSafety.js';
import {
  readWorkOrderRecovery, saveWorkOrderRecovery, discardWorkOrderRecovery
} from '../services/workOrderRecoveryStore.js';

const emptyForm = () => ({
  field_id: '',
  type: 'application',
  priority: 'normal',
  title: '',
  instructions: '',
  due_at: ''
});

function localDatetime(instant) {
  if (!instant) return '';
  const value = new Date(instant);
  return new Date(value.getTime() - value.getTimezoneOffset() * 60000)
    .toISOString().slice(0, 16);
}

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
  const requestRef = useRef(null);

  const [fieldsSnapshot, setFieldsSnapshot] = useState(null);
  const fieldsVisible = fieldsSnapshot?.scope === authority && fieldsSnapshot?.api === api
    ? fieldsSnapshot : null;
  const fields = fieldsVisible?.phase === 'ready' ? fieldsVisible.fields : [];
  const fieldsLoading = Boolean(isOpen && authority && (!fieldsVisible || fieldsVisible.phase === 'loading'));
  const fieldsError = fieldsVisible?.phase === 'error' ? fieldsVisible.error : null;
  const [revision, setRevision] = useState(0);
  // Sensitive lot/order details cannot outlive a tenant or auth transport
  // even for the render preceding a cleanup effect.
  const [formSnapshot, setFormSnapshot] = useState(null);
  const form = formSnapshot?.scope === authority && formSnapshot?.api === api
    ? formSnapshot.value : emptyForm();
  const [saving, setSaving] = useState(false);
  const [submitStatus, setSubmitStatus] = useState('');
  const [error, setError] = useState('');
  const [recoveryState, setRecoveryState] = useState(null);
  const recoveryView = recoveryState?.scope === authority && recoveryState?.api === api
    ? recoveryState : null;
  const recoveryLoading = Boolean(isOpen && dataMode === 'live' && authority &&
    (!recoveryView || recoveryView.phase === 'loading'));
  const recoveryBlocked = Boolean(isOpen && dataMode === 'live' && authority &&
    recoveryView?.phase === 'error');

  useEffect(() => {
    let active = true;
    submitGate.current.reset();
    requestRef.current = null;
    setFormSnapshot({ scope: authority, api, value: emptyForm() });
    setSaving(false);
    setSubmitStatus('');
    setError('');
    setFieldsSnapshot(null);
    setRecoveryState({ scope: authority, api,
      phase: isOpen && dataMode === 'live' && authority ? 'loading' : 'idle' });

    if (isOpen && dataMode === 'live' && authority) {
      // No HTTP operation is triggered on restore: authentication and the
      // operator's explicit action are required for every server replay.
      void readWorkOrderRecovery(authority).then(saved => {
        if (!active || !openRef.current ||
            scopeRef.current !== authority || apiRef.current !== api) return;
        if (saved) {
          requestRef.current = { scope: authority, api, body: saved.body };
          setFormSnapshot({ scope: authority, api, value: {
            field_id: saved.body.field_id,
            type: saved.body.type,
            priority: saved.body.priority,
            title: saved.body.title,
            instructions: saved.body.instructions || '',
            due_at: localDatetime(saved.body.due_at)
          } });
          setSubmitStatus('uncertain');
          setError('Hay una orden pendiente de confirmar. Revisá Órdenes o reintentá exactamente el mismo envío.');
        }
        setRecoveryState({ scope: authority, api, phase: 'ready' });
      }).catch(err => {
        if (!active || !openRef.current ||
            scopeRef.current !== authority || apiRef.current !== api) return;
        setRecoveryState({ scope: authority, api, phase: 'error' });
        setError((err?.message || 'No se pudo recuperar la orden pendiente.') +
          ' No se enviará una orden nueva hasta revisar el almacenamiento.');
      });
    }
    return () => { active = false; submitGate.current.reset(); requestRef.current = null; };
  }, [isOpen, authority, api, dataMode]);

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

  const set = (key) => (event) => {
    if (!editable) return;
    const value = event.target.value;
    setFormSnapshot(previous => ({
      scope: authority, api,
      value: { ...(previous?.scope === authority && previous?.api === api
        ? previous.value : emptyForm()), [key]: value }
    }));
  };

  const safeClose = () => {
    // A POST may have committed even if the connection later fails. Don't let
    // overlay/Escape close a modal while a non-idempotent POST is in flight.
    if (submitGate.current.isPending(authority)) return;
    onClose?.();
  };

  const sendCreate = async (ticket, body, requestApi) => {
    const current = () => openRef.current && scopeRef.current === authority &&
      apiRef.current === requestApi && submitGate.current.isCurrent(ticket) &&
      requestRef.current?.body === body;
    setSaving(true);
    setError('');
    let confirmed = false;
    try {
      if (dataMode === 'mock') {
        confirmed = true; // Demo only; no server persistence is claimed.
      } else {
        const response = await requestApi.createWorkOrder(body);
        if (!current()) return;
        verifyCreatedWorkOrder(response, body, session?.user?.id, session?.tenant?.id);
        const removed = await discardWorkOrderRecovery(authority, body.client_request_id);
        if (!current()) return;
        if (!removed) throw new Error('No se pudo retirar el envío pendiente.');
        confirmed = true;
      }
      if (!current()) return;
      submitGate.current.finish(ticket, 'confirmed');
      setSubmitStatus('confirmed');
    } catch (err) {
      if (!current()) return;
      // COMMIT may precede a dropped ACK. No automatic replay and no fresh UUID.
      submitGate.current.finish(ticket, 'uncertain');
      setSubmitStatus('uncertain');
      setError('No pudimos confirmar la orden. Podés reintentar el mismo envío sin duplicar, o cerrar y revisar el listado de Órdenes.');
    } finally {
      if (current()) setSaving(false);
    }
    if (confirmed && current()) onCreated?.();
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!isOpen || !authority || recoveryLoading || recoveryBlocked ||
        fieldsLoading || fieldsError ||
        !fields.some(field => field.id === form.field_id) ||
        form.title.trim().length < 2) return;
    let due;
    if (form.due_at) {
      const timestamp = new Date(form.due_at);
      if (!Number.isFinite(timestamp.getTime())) {
        setError('La fecha límite de la orden es inválida.');
        return;
      }
      due = timestamp.toISOString();
    }
    if (dataMode === 'live' && (!globalThis.crypto || typeof crypto.randomUUID !== 'function')) {
      setError('Este navegador no permite generar una clave de orden segura. Usá HTTPS o localhost.');
      return;
    }
    const ticket = submitGate.current.acquire(authority);
    if (!ticket) return;
    const body = Object.freeze({
      ...form, due_at: due,
      ...(dataMode === 'live' ? { client_request_id: crypto.randomUUID() } : {})
    });
    requestRef.current = { scope: authority, api, body };
    if (dataMode === 'mock') {
      void sendCreate(ticket, body, api);
      return;
    }
    setSaving(true);
    setError('');
    try {
      // Durability-before-network. If local storage fails or two tabs race,
      // never POST with a new UUID and risk a duplicate after lost ACK.
      await saveWorkOrderRecovery(authority, body);
      if (!openRef.current || scopeRef.current !== authority ||
          apiRef.current !== api || !submitGate.current.isCurrent(ticket)) return;
      void sendCreate(ticket, body, api);
    } catch (err) {
      if (!openRef.current || scopeRef.current !== authority ||
          apiRef.current !== api || !submitGate.current.isCurrent(ticket)) return;
      submitGate.current.finish(ticket, 'preflight-rejected');
      requestRef.current = null;
      setRecoveryState({ scope: authority, api, phase: 'error' });
      setError((err?.message || 'No se pudo guardar el envío cifrado.') +
        ' No se envió la orden. Cerrá y reabrí para revisar su estado local.');
      setSaving(false);
    }
  };

  const handleRetry = () => {
    const saved = requestRef.current;
    if (dataMode !== 'live' || submitStatus !== 'uncertain' ||
        recoveryLoading || recoveryBlocked || !saved ||
        saved.scope !== authority || saved.api !== api) return;
    const ticket = submitGate.current.isBlocked(authority)
      ? submitGate.current.retry(authority)
      : submitGate.current.acquire(authority);
    if (!ticket) return;
    void sendCreate(ticket, saved.body, saved.api);
  };

  const handleDiscard = async () => {
    const saved = requestRef.current;
    if (dataMode !== 'live' || !saved || submitStatus !== 'uncertain' ||
        saving || recoveryLoading || recoveryBlocked ||
        saved.scope !== authority || saved.api !== api ||
        !window.confirm('Revisá primero Órdenes: el servidor podría haber creado esta orden. ¿Descartar la recuperación y permitir una nueva?')) return;
    setSaving(true);
    try {
      const removed = await discardWorkOrderRecovery(authority, saved.body.client_request_id);
      if (!openRef.current || scopeRef.current !== authority || apiRef.current !== api) return;
      if (!removed) throw new Error('Otra pestaña modificó la solicitud pendiente.');
      submitGate.current.reset();
      requestRef.current = null;
      setFormSnapshot({ scope: authority, api, value: emptyForm() });
      setSubmitStatus('');
      setError('');
    } catch (err) {
      if (openRef.current && scopeRef.current === authority && apiRef.current === api) {
        setError(err?.message || 'No se pudo descartar la recuperación.');
      }
    } finally {
      if (openRef.current && scopeRef.current === authority && apiRef.current === api) setSaving(false);
    }
  };

  const blocked = saving || recoveryLoading || recoveryBlocked || submitStatus !== '' ||
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
        {recoveryLoading && <p role="status">Buscando órdenes pendientes cifradas…</p>}
        {recoveryBlocked && <p role="alert">La recuperación de órdenes no está disponible. No se enviarán nuevas órdenes.</p>}
        {fieldsError && <ResourceLoadNotice title="lotes de la orden" error={fieldsError}
          onRetry={() => setRevision(value => value + 1)} />}
        {!fieldsLoading && !fieldsError && fields.length === 0 &&
          <p role="status">No hay lotes disponibles. Registrá un lote antes de crear la orden.</p>}
        {error && <div className="auth-error" role="alert"><span>{error}</span></div>}
        {submitStatus === 'uncertain' && dataMode === 'live' && authority && (
          <>
            <button type="button" className="ghost-action" onClick={handleRetry}
              disabled={saving || recoveryLoading || recoveryBlocked}>
              Reintentar el mismo envío
            </button>
            <button type="button" className="ghost-action" onClick={handleDiscard}
              disabled={saving || recoveryLoading || recoveryBlocked}>
              Descartar tras revisar Órdenes
            </button>
          </>
        )}

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
