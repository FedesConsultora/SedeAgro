import { useEffect, useRef, useState } from 'react';
import { useSession } from '../context/SessionContext.jsx';
import { Modal } from './Modal.jsx';
import {
  campaignCreateScope, createCampaignSubmitGate, prepareCampaignCreate, verifyCreatedCampaign
} from '../services/campaignCreateSafety.js';
import {
  readCampaignRecovery, saveCampaignRecovery, discardCampaignRecovery
} from '../services/campaignRecoveryStore.js';

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
  const [recoveryState, setRecoveryState] = useState(null);
  const checkedRecovery = recoveryState?.scope === authority && recoveryState?.api === api
    ? recoveryState : null;
  const recoveryLoading = Boolean(isOpen && authority &&
    (!checkedRecovery || checkedRecovery.phase === 'loading'));
  const recoveryBlocked = Boolean(isOpen && authority &&
    checkedRecovery?.phase === 'error');

  useEffect(() => {
    let active = true;
    submitGate.current.reset();
    requestRef.current = null;
    setFormSnapshot({ scope: authority, api, value: emptyForm() });
    setSaving(false);
    setSubmitStatus('');
    setError('');
    setRecoveryState({ scope: authority, api, phase: isOpen && authority ? 'loading' : 'idle' });
    if (isOpen && authority) {
      void readCampaignRecovery(authority).then(saved => {
        if (!active || !openRef.current ||
            scopeRef.current !== authority || apiRef.current !== api) return;
        if (saved) {
          requestRef.current = { scope: authority, api, body: saved.body };
          setFormSnapshot({ scope: authority, api, value: {
            name: saved.body.name, season_year: String(saved.body.season_year),
            starts_at: saved.body.starts_at, ends_at: saved.body.ends_at || '',
            status: saved.body.status
          } });
          setSubmitStatus('uncertain');
          setError('Hay una creación pendiente de confirmar. Revisá Campañas o reintentá el envío original. No se creó ninguna solicitud nueva.');
        }
        setRecoveryState({ scope: authority, api, phase: 'ready' });
      }).catch(err => {
        if (!active || !openRef.current ||
            scopeRef.current !== authority || apiRef.current !== api) return;
        setRecoveryState({ scope: authority, api, phase: 'error' });
        setError((err?.message || 'No se pudo recuperar la campaña.') +
          ' No se enviará ninguna campaña nueva hasta reparar el almacenamiento.');
      });
    }
    return () => { active = false; submitGate.current.reset(); requestRef.current = null; };
  }, [isOpen, authority, api]);

  const safeClose = () => {
    // Close via Escape, overlay, X and Cancelar all use the same guard.
    if (submitGate.current.isPending(authority)) return;
    onClose?.();
  };

  const blocked = saving || recoveryLoading || recoveryBlocked || submitStatus !== '' ||
    submitGate.current.isBlocked(authority);
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
      // The server ACK is exact; retire the durable uncertain journal BEFORE
      // claiming success. If IndexedDB fails, retain the SAME key for retry.
      const retired = await discardCampaignRecovery(authority, body.client_request_id);
      if (!current()) return;
      if (!retired) throw new Error('No se pudo retirar el envío pendiente.');
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

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!isOpen || !authority || recoveryLoading || recoveryBlocked) return;
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
    setSaving(true);
    setError('');
    // Fail closed: never POST a new campaign until the exact immutable body
    // and key are durably encrypted in IndexedDB. A crashed tab can resume it.
    try {
      await saveCampaignRecovery(authority, body);
      if (!openRef.current || scopeRef.current !== authority ||
          apiRef.current !== api || !submitGate.current.isCurrent(ticket)) return;
      void sendCreate(ticket, body, api);
    } catch (err) {
      if (!openRef.current || scopeRef.current !== authority ||
          apiRef.current !== api || !submitGate.current.isCurrent(ticket)) return;
      submitGate.current.finish(ticket, 'preflight-rejected');
      requestRef.current = null;
      setError((err?.message || 'No se pudo guardar el envío cifrado.') +
        ' No se envió ninguna campaña. Volvé a abrir el formulario para revisar el estado local.');
      setRecoveryState({ scope: authority, api, phase: 'error' });
      setSaving(false);
    }
  };

  const handleRetry = () => {
    const saved = requestRef.current;
    if (!saved || submitStatus !== 'uncertain' || recoveryLoading || recoveryBlocked ||
        saved.scope !== authority || saved.api !== api) return;
    // On a cold browser reload the original ticket no longer exists; acquire
    // once for the restored journal. Within one modal opening retry() keeps
    // the exact synchronous double-click fence.
    const ticket = submitGate.current.isBlocked(authority)
      ? submitGate.current.retry(authority)
      : submitGate.current.acquire(authority);
    if (!ticket) return; // double retry blocked synchronously
    void sendCreate(ticket, saved.body, saved.api);
  };

  const handleDiscard = async () => {
    const saved = requestRef.current;
    if (!saved || submitStatus !== 'uncertain' || saving ||
        saved.scope !== authority || saved.api !== api ||
        !window.confirm('Revisá primero la lista de Campañas: este envío podría haber sido guardado por el servidor. ¿Descartar la recuperación y permitir una campaña nueva?')) return;
    setSaving(true);
    try {
      const discarded = await discardCampaignRecovery(authority, saved.body.client_request_id);
      if (!openRef.current || scopeRef.current !== authority || apiRef.current !== api) return;
      if (!discarded) throw new Error('El envío pendiente cambió en otra pestaña.');
      submitGate.current.reset();
      requestRef.current = null;
      setFormSnapshot({ scope: authority, api, value: emptyForm() });
      setSubmitStatus('');
      setError('');
    } catch (err) {
      if (openRef.current && scopeRef.current === authority && apiRef.current === api) {
        setError(err?.message || 'No se pudo descartar el envío cifrado.');
      }
    } finally {
      if (openRef.current && scopeRef.current === authority && apiRef.current === api) {
        setSaving(false);
      }
    }
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
        {recoveryLoading && <p role="status">Comprobando envíos pendientes cifrados…</p>}
        {recoveryBlocked && <p role="alert">La recuperación segura de campañas no está disponible. No se enviarán solicitudes nuevas.</p>}
        {error && <div className="auth-error" role="alert" style={{ marginBottom: 0 }}><span>{error}</span></div>}
        {submitStatus === 'uncertain' && authority && (
          <>
            <button type="button" className="ghost-action" onClick={handleRetry}
              disabled={saving || recoveryLoading || recoveryBlocked}>
              Reintentar el mismo envío
            </button>
            <button type="button" className="ghost-action" onClick={handleDiscard}
              disabled={saving || recoveryLoading || recoveryBlocked}>
              Descartar tras revisar Campañas
            </button>
          </>
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
