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
  const requestRef = useRef(null);

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
    requestRef.current = null;
    setFormSnapshot({ scope: authority, api, value: emptyForm() });
    setSaving(false);
    setSubmitStatus('');
    setError('');
    return () => { submitGate.current.reset(); requestRef.current = null; };
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

  const sendCreate = async (ticket, body, requestApi) => {
    const current = () => openRef.current && scopeRef.current === authority &&
      apiRef.current === requestApi && submitGate.current.isCurrent(ticket) &&
      requestRef.current?.body === body;
    setSaving(true);
    setError('');
    let confirmed = false;
    try {
      const response = await requestApi.createCampaign(body);
      if (!current()) return;
      verifyCreatedCampaign(response, body, session?.tenant?.id);
      submitGate.current.finish(ticket, 'confirmed');
      setSubmitStatus('confirmed');
      confirmed = true;
    } catch (err) {
      if (!current()) return;
      // A transport failure or inconsistent HTTP 2xx may follow COMMIT.
      // No automatic resend and no new request key from this opening.
      submitGate.current.finish(ticket, 'uncertain');
      setSubmitStatus('uncertain');
      setError('No pudimos confirmar la campaña. Podés reintentar exactamente el mismo envío de forma segura, o cerrar y revisar la lista de Campañas.');
    } finally {
      if (current()) setSaving(false);
    }
    if (confirmed && current()) onCreated?.();
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    if (!isOpen || !authority) return;
    let prepared;
    try {
      prepared = prepareCampaignCreate(form);
    } catch (err) {
      setError(err?.message || 'Revisá los datos de campaña.');
      return;
    }
    if (!globalThis.crypto || typeof crypto.randomUUID !== 'function') {
      setError('Este navegador no puede generar una clave segura. Usá HTTPS o localhost.');
      return;
    }
    const ticket = submitGate.current.acquire(authority);
    if (!ticket) return; // one-shot fence before any async request
    const body = Object.freeze({ ...prepared, client_request_id: crypto.randomUUID() });
    requestRef.current = { scope: authority, api, body };
    void sendCreate(ticket, body, api);
  };

  const handleRetry = () => {
    const saved = requestRef.current;
    if (!saved || submitStatus !== 'uncertain' ||
        saved.scope !== authority || saved.api !== api) return;
    const ticket = submitGate.current.retry(authority);
    if (!ticket) return; // double retry blocked synchronously
    void sendCreate(ticket, saved.body, saved.api);
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
        {submitStatus === 'uncertain' && authority && (
          <button type="button" className="ghost-action" onClick={handleRetry}
            disabled={saving}>
            Reintentar el mismo envío
          </button>
        )}

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
