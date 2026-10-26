import { useEffect, useRef, useState } from 'react';
import { useSession } from '../context/SessionContext.jsx';
import { Modal } from './Modal.jsx';
import {
  createScoutingRunSubmitGate, scoutingRunCreateScope, verifyCreatedScoutingRun
} from '../services/scoutingRunCreateSafety.js';
import {
  readScoutingRunRecovery, saveScoutingRunRecovery, discardScoutingRunRecovery
} from '../services/scoutingRunRecoveryStore.js';

const emptyForm = () => ({
  campaign_field_id: '', assigned_to: '', scheduled_at: '', status: 'planned', summary: ''
});

function localDatetime(instant) {
  if (!instant) return '';
  const date = new Date(instant);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

export function ScoutingRunFormModal({ isOpen, onClose, onCreated }) {
  const { api, dataMode, session } = useSession();
  const authority = scoutingRunCreateScope(session, dataMode);
  const scopeRef = useRef(authority);
  scopeRef.current = authority;
  const apiRef = useRef(api);
  apiRef.current = api;
  const openRef = useRef(isOpen);
  openRef.current = isOpen;
  const submitGate = useRef(null);
  if (!submitGate.current) submitGate.current = createScoutingRunSubmitGate();
  const requestRef = useRef(null);

  // Lists can contain tenant-private lot and user names. Never show a previous
  // account's response while an effect is still clearing its React state.
  const [optionsSnapshot, setOptionsSnapshot] = useState(null);
  const visible = optionsSnapshot?.scope === authority && optionsSnapshot?.api === api
    ? optionsSnapshot : null;
  const campaignFields = visible?.phase === 'ready' ? visible.fields : [];
  const assignees = visible?.phase === 'ready' ? visible.assignees : [];
  const loading = Boolean(isOpen && authority && (!visible || visible.phase === 'loading'));
  const optionsError = visible?.phase === 'error' ? visible.error : '';
  const [reload, setReload] = useState(0);
  const [formSnapshot, setFormSnapshot] = useState(null);
  const form = formSnapshot?.scope === authority && formSnapshot?.api === api
    ? formSnapshot.value : emptyForm();
  const [saving, setSaving] = useState(false);
  const [submitStatus, setSubmitStatus] = useState('');
  const [error, setError] = useState('');
  const [recoveryState, setRecoveryState] = useState(null);
  const checkedRecovery = recoveryState?.scope === authority && recoveryState?.api === api
    ? recoveryState : null;
  const recoveryLoading = Boolean(isOpen && authority &&
    (!checkedRecovery || checkedRecovery.phase === 'loading'));
  const recoveryBlocked = Boolean(isOpen && authority && checkedRecovery?.phase === 'error');
  const blocked = saving || recoveryLoading || recoveryBlocked || submitStatus !== '' ||
    submitGate.current.isBlocked(authority);
  const editable = Boolean(authority) && !blocked;

  useEffect(() => {
    let active = true;
    // Openings and authenticated actor changes must not adopt stale HTTP ACKs.
    submitGate.current.reset();
    requestRef.current = null;
    setFormSnapshot({ scope: authority, api, value: emptyForm() });
    setSaving(false);
    setSubmitStatus('');
    setError('');
    setOptionsSnapshot(null);
    setRecoveryState({ scope: authority, api, phase: isOpen && authority ? 'loading' : 'idle' });
    if (isOpen && authority) {
      void readScoutingRunRecovery(authority).then(saved => {
        if (!active || !openRef.current ||
            scopeRef.current !== authority || apiRef.current !== api) return;
        if (saved) {
          requestRef.current = { scope: authority, api, body: saved.body };
          setFormSnapshot({ scope: authority, api, value: {
            campaign_field_id: saved.body.campaign_field_id,
            assigned_to: saved.body.assigned_to || '',
            scheduled_at: localDatetime(saved.body.scheduled_at),
            status: saved.body.status,
            summary: saved.body.summary || ''
          } });
          setSubmitStatus('uncertain');
          setError('Hay una recorrida pendiente de confirmar. Revisá Recorridas o reintentá exactamente el envío anterior.');
        }
        setRecoveryState({ scope: authority, api, phase: 'ready' });
      }).catch(err => {
        if (!active || !openRef.current ||
            scopeRef.current !== authority || apiRef.current !== api) return;
        setRecoveryState({ scope: authority, api, phase: 'error' });
        setError((err?.message || 'No se pudo recuperar la recorrida.') +
          ' No se enviará otra recorrida hasta revisar el almacenamiento.');
      });
    }
    return () => { active = false; submitGate.current.reset(); requestRef.current = null; };
  }, [isOpen, authority, api]);

  useEffect(() => {
    if (!isOpen || !authority) return undefined;
    let active = true;
    const requestScope = authority;
    const requestApi = api;
    const current = () => active && openRef.current &&
      scopeRef.current === requestScope && apiRef.current === requestApi;
    setOptionsSnapshot({ scope: requestScope, api: requestApi, phase: 'loading',
      fields: [], assignees: [], error: '' });
    const load = async () => {
      try {
        const [fieldsResponse, peopleResponse] = await Promise.all([
          requestApi.campaignFields(), requestApi.scoutingAssignees()
        ]);
        const fields = fieldsResponse?.data;
        const people = peopleResponse?.data;
        if (!Array.isArray(fields) || fields.some(item => !item || typeof item.id !== 'string') ||
            !Array.isArray(people) || people.some(item => !item || typeof item.id !== 'string')) {
          throw new Error('El servidor devolvió lotes o responsables inválidos.');
        }
        if (current()) setOptionsSnapshot({ scope: requestScope, api: requestApi,
          phase: 'ready', fields, assignees: people, error: '' });
      } catch (err) {
        if (current()) setOptionsSnapshot({ scope: requestScope, api: requestApi,
          phase: 'error', fields: [], assignees: [],
          error: err?.message || 'No se pudieron consultar lotes y responsables.' });
      }
    };
    void load();
    return () => { active = false; };
  }, [isOpen, authority, api, reload]);

  const set = (key) => (event) => {
    if (!editable) return;
    const value = event.target.value;
    setFormSnapshot(current => ({
      scope: authority, api,
      value: { ...(current?.scope === authority && current?.api === api
        ? current.value : emptyForm()), [key]: value }
    }));
  };

  const safeClose = () => {
    // Escape, overlay and the X button use this same callback.
    // Do not hide a pending non-idempotent creation before its outcome.
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
      const response = await requestApi.createScoutingRun(body);
      if (!current()) return;
      verifyCreatedScoutingRun(response, body, session?.tenant?.id);
      // A verified exact server receipt retires only its matching encrypted
      // slot; a failed local COMMIT leaves the key available for safe replay.
      const retired = await discardScoutingRunRecovery(authority, body.client_request_id);
      if (!current()) return;
      if (!retired) throw new Error('No se pudo retirar el envío local.');
      submitGate.current.finish(ticket, 'confirmed');
      setSubmitStatus('confirmed');
      confirmed = true;
    } catch (err) {
      if (!current()) return;
      // The server may have COMMITted before the network/ACK failed.
      submitGate.current.finish(ticket, 'uncertain');
      setSubmitStatus('uncertain');
      setError('No pudimos confirmar la creación. Podés reintentar ESTE MISMO envío de forma segura, o cerrar y revisar Recorridas antes de crear otra.');
    } finally {
      if (current()) setSaving(false);
    }
    if (confirmed && current()) onCreated?.();
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!isOpen || !authority || recoveryLoading || recoveryBlocked ||
        loading || visible?.phase !== 'ready' ||
        !campaignFields.some(field => field.id === form.campaign_field_id)) return;
    if (form.assigned_to && !assignees.some(person => person.id === form.assigned_to)) {
      setError('Seleccioná un responsable activo de esta empresa.');
      return;
    }
    if (form.status === 'in_progress' && !form.assigned_to) {
      setError('Seleccioná un responsable antes de iniciar una recorrida.');
      return;
    }
    const scheduledDate = form.scheduled_at ? new Date(form.scheduled_at) : null;
    if (scheduledDate && !Number.isFinite(scheduledDate.getTime())) {
      setError('La fecha planificada no es válida.');
      return;
    }
    if (!globalThis.crypto || typeof crypto.randomUUID !== 'function') {
      setError('Este navegador no permite crear un identificador seguro de recorrida. Usá HTTPS o localhost.');
      return;
    }
    // Immutable body and UUID: retry MUST replay this identical request.
    const body = Object.freeze({
      client_request_id: crypto.randomUUID(),
      campaign_field_id: form.campaign_field_id,
      assigned_to: form.assigned_to || null,
      ...(scheduledDate ? { scheduled_at: scheduledDate.toISOString() } : {}),
      status: form.status,
      ...(form.summary ? { summary: form.summary } : {})
    });
    const ticket = submitGate.current.acquire(authority);
    if (!ticket) return; // barrier before any POST and before React rerender
    requestRef.current = { scope: authority, api, body };
    setSaving(true);
    setError('');
    try {
      // No HTTP POST until the immutable body and client UUID are durably
      // encrypted. Crash, tab close or tenant switch cannot lose the key.
      await saveScoutingRunRecovery(authority, body);
      if (!openRef.current || scopeRef.current !== authority ||
          apiRef.current !== api || !submitGate.current.isCurrent(ticket)) return;
      void sendCreate(ticket, body, api);
    } catch (err) {
      if (!openRef.current || scopeRef.current !== authority ||
          apiRef.current !== api || !submitGate.current.isCurrent(ticket)) return;
      submitGate.current.finish(ticket, 'preflight-rejected');
      requestRef.current = null;
      setRecoveryState({ scope: authority, api, phase: 'error' });
      setError((err?.message || 'No se pudo cifrar el envío de recorrida.') +
        ' No se envió ninguna recorrida. Cerrá y reabrí para revisar el envío local.');
      setSaving(false);
    }
  };

  const handleRetry = () => {
    const saved = requestRef.current;
    if (submitStatus !== 'uncertain' || recoveryLoading || recoveryBlocked || !saved ||
        saved.scope !== authority || saved.api !== api) return;
    const ticket = submitGate.current.isBlocked(authority)
      ? submitGate.current.retry(authority)
      : submitGate.current.acquire(authority);
    if (!ticket) return; // blocks double retry even before setSaving renders
    void sendCreate(ticket, saved.body, saved.api);
  };

  const handleDiscard = async () => {
    const saved = requestRef.current;
    if (!saved || submitStatus !== 'uncertain' || saving ||
        saved.scope !== authority || saved.api !== api ||
        !window.confirm('Revisá primero Recorridas: el servidor podría haber creado este recorrido. ¿Descartar su recuperación y permitir una nueva recorrida?')) return;
    setSaving(true);
    try {
      const discarded = await discardScoutingRunRecovery(authority, saved.body.client_request_id);
      if (!openRef.current || scopeRef.current !== authority || apiRef.current !== api) return;
      if (!discarded) throw new Error('Otra pestaña cambió el envío pendiente.');
      submitGate.current.reset();
      requestRef.current = null;
      setFormSnapshot({ scope: authority, api, value: emptyForm() });
      setSubmitStatus('');
      setError('');
    } catch (err) {
      if (openRef.current && scopeRef.current === authority && apiRef.current === api) {
        setError(err?.message || 'No se pudo descartar el envío.');
      }
    } finally {
      if (openRef.current && scopeRef.current === authority && apiRef.current === api) {
        setSaving(false);
      }
    }
  };
  return (
    <Modal isOpen={isOpen} onClose={safeClose} title="Nueva recorrida de monitoreo"
      footer={<>
        <button type="button" className="ghost-action" onClick={safeClose}
          disabled={saving}>Cancelar</button>
        <button type="submit" form="scouting-run-form" className="primary-action"
          disabled={!editable || loading || Boolean(optionsError) || campaignFields.length === 0}>
          {saving ? 'Guardando…' : submitStatus === 'uncertain'
            ? 'Confirmación pendiente' : 'Crear recorrida'}
        </button>
      </>}
    >
      <form id="scouting-run-form" onSubmit={handleSubmit} style={{ display: 'grid', gap: 14 }}>
        {!authority && dataMode === 'live' &&
          <div className="auth-error" role="alert">Tu sesión no permite planificar recorridas.</div>}
        {loading && <p role="status">Cargando lotes y responsables autorizados…</p>}
        {recoveryLoading && <p role="status">Comprobando recorridas cifradas pendientes…</p>}
        {recoveryBlocked && <p role="alert">La recuperación segura no está disponible. No se enviarán recorridas nuevas.</p>}
        {optionsError && <div className="auth-error" role="alert">
          <span>{optionsError}</span>
          <button type="button" onClick={() => setReload(value => value + 1)}>Reintentar</button>
        </div>}
        {error && <div className="auth-error" role="alert"><span>{error}</span></div>}
        {submitStatus === 'uncertain' && authority && (
          <>
            <button type="button" className="ghost-action" onClick={handleRetry}
              disabled={saving || recoveryLoading || recoveryBlocked || !requestRef.current}>
              Reintentar el mismo envío (sin duplicar)
            </button>
            <button type="button" className="ghost-action" onClick={handleDiscard}
              disabled={saving || recoveryLoading || recoveryBlocked || !requestRef.current}>
              Descartar tras revisar Recorridas
            </button>
          </>
        )}
        {!loading && authority && !optionsError && campaignFields.length === 0 &&
          <p role="status">No hay lotes asociados a campañas disponibles para planificar recorridas.</p>}
        <label className="form-field">
          <span>Lote / campaña *</span>
          <select value={form.campaign_field_id} onChange={set('campaign_field_id')}
            disabled={!editable || loading || Boolean(optionsError)} required>
            <option value="">Seleccioná lote y campaña</option>
            {campaignFields.map((field) => (
              <option key={field.id} value={field.id}>
                {field.Field?.name || 'Lote'} — {field.Campaign?.name || 'Campaña'} ({field.CropType?.name || '–'})
              </option>
            ))}
          </select>
        </label>
        <label className="form-field">
          <span>Responsable</span>
          <select value={form.assigned_to} onChange={set('assigned_to')}
            disabled={!editable || loading || Boolean(optionsError)}>
            <option value="">Sin asignar (solo planificada)</option>
            {assignees.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name} · {person.role_code === 'scout' ? 'Monitoreador' : 'Coordinador'}
              </option>
            ))}
          </select>
        </label>
        {authority && !loading && assignees.length === 0 && !optionsError &&
          <p role="status" style={{ margin: 0, color: '#a16207', fontSize: 12 }}>
            No hay responsables activos. Podés planificar la recorrida sin asignarla, pero no iniciarla.
          </p>}
        <div className="form-row">
          <label className="form-field">
            <span>Fecha planificada</span>
            <input type="datetime-local" value={form.scheduled_at} onChange={set('scheduled_at')}
              disabled={!editable}/>
          </label>
          <label className="form-field">
            <span>Estado inicial</span>
            <select value={form.status} onChange={set('status')} disabled={!editable}>
              <option value="planned">Planificada</option>
              <option value="in_progress">En curso (requiere responsable)</option>
            </select>
          </label>
        </div>
        <label className="form-field">
          <span>Descripción de la recorrida</span>
          <textarea rows={3} maxLength={5000} value={form.summary} onChange={set('summary')}
            placeholder="Objetivo del monitoreo, sectores a revisar…" disabled={!editable}/>
        </label>
        {dataMode !== 'live' && <p role="status" style={{ color: '#a16207', margin: 0 }}>
          Vista demo. Las recorridas solo pueden guardarse conectando el backend.
        </p>}
      </form>
    </Modal>
  );
}
