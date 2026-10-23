import { useEffect, useRef, useState } from 'react';
import { useSession } from '../context/SessionContext.jsx';
import { Modal } from './Modal.jsx';
import {
  createScoutingRunSubmitGate, scoutingRunCreateScope, verifyCreatedScoutingRun
} from '../services/scoutingRunCreateSafety.js';

const emptyForm = () => ({
  campaign_field_id: '', assigned_to: '', scheduled_at: '', status: 'planned', summary: ''
});

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
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [submitStatus, setSubmitStatus] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    // A new opening/actor/role/permission set starts with a new one-shot ticket.
    submitGate.current.reset();
    setForm(emptyForm());
    setSaving(false);
    setSubmitStatus('');
    setError('');
    setOptionsSnapshot(null);
    return () => { submitGate.current.reset(); };
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

  const set = (key) => (event) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  const safeClose = () => {
    // Escape, overlay and the X button use this same callback.
    // Do not hide a pending non-idempotent creation before its outcome.
    if (submitGate.current.isPending(authority)) return;
    onClose?.();
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!isOpen || !authority || loading || visible?.phase !== 'ready' ||
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
    const body = {
      campaign_field_id: form.campaign_field_id,
      assigned_to: form.assigned_to || null,
      ...(scheduledDate ? { scheduled_at: scheduledDate.toISOString() } : {}),
      status: form.status,
      ...(form.summary ? { summary: form.summary } : {})
    };
    const ticket = submitGate.current.acquire(authority);
    if (!ticket) return; // synchronous barrier before awaiting any network call
    const requestApi = api;
    const current = () => openRef.current && scopeRef.current === authority &&
      apiRef.current === requestApi && submitGate.current.isCurrent(ticket);
    setSaving(true);
    setError('');
    let transmitted = false;
    let confirmed = false;
    try {
      transmitted = true;
      const response = await requestApi.createScoutingRun(body);
      if (!current()) return;
      verifyCreatedScoutingRun(response, body, session?.tenant?.id);
      confirmed = true;
      submitGate.current.finish(ticket, 'confirmed');
      setSubmitStatus('confirmed');
    } catch (err) {
      if (!current()) return;
      // Even an HTTP error can arrive after a DB commit. No automatic replay.
      submitGate.current.finish(ticket, transmitted ? 'uncertain' : 'preflight-rejected');
      setSubmitStatus(transmitted ? 'uncertain' : '');
      setError(transmitted
        ? 'No se pudo confirmar si la recorrida quedó creada. Cerrá este formulario, actualizá la lista de Recorridas y revisá antes de intentar otra.'
        : err?.message || 'No se pudo preparar la recorrida.');
    } finally {
      if (current()) setSaving(false);
    }
    if (confirmed && current()) onCreated?.();
  };

  const blocked = saving || submitStatus !== '' || submitGate.current.isBlocked(authority);
  const editable = Boolean(authority) && !blocked;
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
        {optionsError && <div className="auth-error" role="alert">
          <span>{optionsError}</span>
          <button type="button" onClick={() => setReload(value => value + 1)}>Reintentar</button>
        </div>}
        {error && <div className="auth-error" role="alert"><span>{error}</span></div>}
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
