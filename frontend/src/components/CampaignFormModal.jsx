import { useEffect, useRef, useState } from 'react';
import { useSession } from '../context/SessionContext.jsx';
import { Modal } from './Modal.jsx';
import {
  campaignCreateScope, createCampaignSubmitGate, prepareCampaignCreate, verifyCreatedCampaign
} from '../services/campaignCreateSafety.js';

function emptyForm() {
  const year = new Date().getFullYear();
  return {
    name: '',
    season_year: String(year),
    starts_at: year + '-09-01',
    ends_at: (year + 1) + '-07-31',
    status: 'planned'
  };
}

export function CampaignFormModal({ isOpen, onClose, onCreated }) {
  const { api, dataMode, session } = useSession();
  const authority = campaignCreateScope(session, dataMode);
  const scopeRef = useRef(authority);
  scopeRef.current = authority;
  const apiRef = useRef(api);
  apiRef.current = api;
  const openRef = useRef(isOpen);
  openRef.current = isOpen;
  const submitGate = useRef(null);
  if (!submitGate.current) submitGate.current = createCampaignSubmitGate();

  // The form may contain a tenant's confidential campaign name. A new session
  // cannot render the old form while waiting for an effect to reset state.
  const [formSnapshot, setFormSnapshot] = useState(null);
  const form = formSnapshot?.scope === authority && formSnapshot?.api === api
    ? formSnapshot.value : emptyForm();
  const [saving, setSaving] = useState(false);
  const [submitStatus, setSubmitStatus] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    submitGate.current.reset();
    setFormSnapshot({ scope: authority, api, value: emptyForm() });
    setSaving(false);
    setSubmitStatus('');
    setError('');
    return () => { submitGate.current.reset(); };
  }, [isOpen, authority, api]);

  const safeClose = () => {
    // Close via Escape, overlay, X and Cancelar all use the same guard.
    if (submitGate.current.isPending(authority)) return;
    onClose?.();
  };

  const blocked = saving || submitStatus !== '' || submitGate.current.isBlocked(authority);
  const editable = Boolean(authority) && !blocked;
  const set = (key) => (event) => {
    if (!editable) return;
    const value = event.target.value;
    setFormSnapshot(current => ({
      scope: authority, api,
      value: {
        ...(current?.scope === authority && current?.api === api ? current.value : emptyForm()),
        [key]: value
      }
    }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!isOpen || !authority) return;
    let body;
    try {
      // All preflight validation happens before acquiring the one-shot ticket.
      body = prepareCampaignCreate(form);
    } catch (err) {
      setError(err?.message || 'Revisá los datos de campaña.');
      return;
    }
    const ticket = submitGate.current.acquire(authority);
    if (!ticket) return; // synchronous barrier before React rerender
    const requestApi = api;
    const current = () => openRef.current && scopeRef.current === authority &&
      apiRef.current === requestApi && submitGate.current.isCurrent(ticket);
    setSaving(true);
    setError('');
    let transmitted = false;
    let confirmed = false;
    try {
      transmitted = true;
      const response = await requestApi.createCampaign(body);
      if (!current()) return;
      verifyCreatedCampaign(response, body, session?.tenant?.id);
      submitGate.current.finish(ticket, 'confirmed');
      setSubmitStatus('confirmed');
      confirmed = true;
    } catch (err) {
      if (!current()) return;
      // A 500 or transport timeout is not proof no row was committed.
      submitGate.current.finish(ticket, transmitted ? 'uncertain' : 'preflight-rejected');
      setSubmitStatus(transmitted ? 'uncertain' : '');
      setError(transmitted
        ? 'No pudimos confirmar si se creó la campaña. Cerrá este formulario, actualizá la lista de Campañas y revisá antes de intentar otra.'
        : err?.message || 'No se pudo preparar la campaña.');
    } finally {
      if (current()) setSaving(false);
    }
    if (confirmed && current()) onCreated?.();
  };

  return (
    <Modal isOpen={isOpen} onClose={safeClose} title="Nueva campaña"
      footer={<>
        <button type="button" className="ghost-action" onClick={safeClose} disabled={saving}>
          Cancelar
        </button>
        <button type="submit" form="campaign-form" className="primary-action" disabled={!editable}>
          {saving ? 'Guardando…' : submitStatus === 'uncertain' ? 'Confirmación pendiente' : 'Crear campaña'}
        </button>
      </>}
    >
      <form id="campaign-form" onSubmit={handleSubmit} style={{ display: 'contents' }}>
        {!authority && dataMode === 'live' &&
          <p role="alert" className="auth-error">Tu sesión no permite crear campañas.</p>}
        {dataMode !== 'live' &&
          <p role="status">Vista demo. Conectá el backend para guardar una campaña real.</p>}
        {error && <div className="auth-error" role="alert" style={{ marginBottom: 0 }}><span>{error}</span></div>}

        <label className="form-field">
          <span>Nombre de la campaña *</span>
          <input id="campaign-name" value={form.name} onChange={set('name')}
            disabled={!editable} required minLength={2} maxLength={160}
            placeholder="Campaña gruesa 2026/27" />
        </label>

        <div className="form-row">
          <label className="form-field">
            <span>Año de campaña *</span>
            <input id="campaign-year" type="number" min="2000" max="2100"
              value={form.season_year} onChange={set('season_year')} disabled={!editable} required />
          </label>
          <label className="form-field">
            <span>Estado</span>
            <select id="campaign-status" value={form.status} onChange={set('status')} disabled={!editable}>
              <option value="planned">Planificado</option>
              <option value="active">Activo</option>
              <option value="closed">Cerrado</option>
            </select>
          </label>
        </div>

        <div className="form-row">
          <label className="form-field">
            <span>Fecha inicio *</span>
            <input id="campaign-starts" type="date" value={form.starts_at}
              onChange={set('starts_at')} disabled={!editable} required />
          </label>
          <label className="form-field">
            <span>Fecha fin estimada</span>
            <input id="campaign-ends" type="date" value={form.ends_at}
              onChange={set('ends_at')} disabled={!editable} />
          </label>
        </div>
      </form>
    </Modal>
  );
}
