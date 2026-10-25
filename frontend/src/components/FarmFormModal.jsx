import { useEffect, useRef, useState } from 'react';
import { useSession } from '../context/SessionContext.jsx';
import { Modal } from './Modal.jsx';
import { ResourceLoadNotice } from './ResourceLoadNotice.jsx';
import {
  farmCreateScope, prepareFarmCreate, verifyCreatedFarm, createFarmSubmitGate
} from '../services/farmCreateSafety.js';

const emptyForm = () => ({
  name: '', locality: '', province: '', country: 'Argentina', producer_id: '', notes: ''
});

export function FarmFormModal({ isOpen, onClose, onCreated }) {
  const { api, dataMode, session } = useSession();
  const authority = farmCreateScope(session, dataMode);
  const scopeRef = useRef(authority);
  scopeRef.current = authority;
  const apiRef = useRef(api);
  apiRef.current = api;
  const openRef = useRef(isOpen);
  openRef.current = isOpen;
  const gate = useRef(null);
  if (!gate.current) gate.current = createFarmSubmitGate();
  const requestRef = useRef(null);
  const [producerSnapshot, setProducerSnapshot] = useState(null);
  const visible = producerSnapshot?.scope === authority && producerSnapshot?.api === api
    ? producerSnapshot : null;
  const producers = visible?.phase === 'ready' ? visible.producers : [];
  const producersLoading = Boolean(isOpen && authority &&
    (!visible || visible.phase === 'loading'));
  const producersError = visible?.phase === 'error' ? visible.error : '';
  const [retry, setRetry] = useState(0);
  const [formSnapshot, setFormSnapshot] = useState(null);
  const form = formSnapshot?.scope === authority && formSnapshot?.api === api
    ? formSnapshot.form : emptyForm();
  const [saving, setSaving] = useState(false);
  const [submitStatus, setSubmitStatus] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    gate.current.reset();
    requestRef.current = null;
    setProducerSnapshot(null);
    setFormSnapshot({ scope: authority, api, form: emptyForm() });
    setSaving(false);
    setSubmitStatus('');
    setError('');
    return () => { gate.current.reset(); requestRef.current = null; };
  }, [isOpen, authority, api]);

  useEffect(() => {
    if (!isOpen || !authority) return undefined;
    let active = true;
    const requestScope = authority;
    const requestApi = api;
    const current = () => active && openRef.current &&
      scopeRef.current === requestScope && apiRef.current === requestApi;
    setProducerSnapshot({ scope: requestScope, api: requestApi,
      phase: 'loading', producers: [], error: '' });
    void (async () => {
      try {
        const reply = await requestApi.producers();
        const rows = reply?.data;
        if (!Array.isArray(rows) || rows.some(p => !p || typeof p.id !== 'string' ||
            (p.tenant_id && p.tenant_id !== session?.tenant?.id))) {
          throw new Error('Lista de productores inválida para esta empresa.');
        }
        if (current()) setProducerSnapshot({ scope: requestScope, api: requestApi,
          phase: 'ready', producers: rows, error: '' });
      } catch (err) {
        if (current()) setProducerSnapshot({ scope: requestScope, api: requestApi,
          phase: 'error', producers: [],
          error: err?.message || 'No se pudieron consultar productores autorizados.' });
      }
    })();
    return () => { active = false; };
  }, [isOpen, api, authority, session?.tenant?.id, retry]);

  const safeClose = () => {
    if (gate.current.isPending(authority)) return;
    onClose?.();
  };
  const blocked = saving || submitStatus !== '' || gate.current.isBlocked(authority);
  const editable = Boolean(authority) && visible?.phase === 'ready' && !blocked;
  const set = (key) => (event) => {
    if (!editable) return;
    const value = event.target.value;
    setFormSnapshot(prev => ({
      scope: authority, api, form: {
        ...(prev?.scope === authority && prev?.api === api ? prev.form : emptyForm()),
        [key]: value
      }
    }));
  };

  const sendCreate = async (ticket, body, requestApi) => {
    const current = () => openRef.current && scopeRef.current === authority &&
      apiRef.current === requestApi && gate.current.isCurrent(ticket) &&
      requestRef.current?.body === body;
    setSaving(true);
    setError('');
    let confirmed = false;
    let farm = null;
    try {
      const response = await requestApi.createFarm(body);
      if (!current()) return;
      farm = verifyCreatedFarm(response, body, session?.tenant?.id);
      gate.current.finish(ticket, 'confirmed');
      setSubmitStatus('confirmed');
      confirmed = true;
    } catch (err) {
      if (!current()) return;
      gate.current.finish(ticket, 'uncertain');
      setSubmitStatus('uncertain');
      setError('No pudimos confirmar la creación. Podés reintentar exactamente el mismo envío de forma segura, o cerrar y comprobar el listado de Establecimientos.');
    } finally {
      if (current()) setSaving(false);
    }
    if (confirmed && current()) onCreated?.(farm);
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    if (!isOpen || !editable) return;
    let body;
    try {
      body = prepareFarmCreate(form, producers, session?.tenant?.id);
    } catch (err) {
      setError(err?.message || 'Revisá los datos del establecimiento.');
      return;
    }
    const ticket = gate.current.acquire(authority);
    if (!ticket) return; // synchronous barrier before any asynchronous POST
    requestRef.current = { scope: authority, api, body };
    void sendCreate(ticket, body, api);
  };

  const retrySame = () => {
    const saved = requestRef.current;
    if (!saved || submitStatus !== 'uncertain' ||
        saved.scope !== authority || saved.api !== api) return;
    const ticket = gate.current.retry(authority);
    if (!ticket) return;
    void sendCreate(ticket, saved.body, saved.api);
  };

  return (
    <Modal isOpen={isOpen} onClose={safeClose} title="Nuevo establecimiento"
      footer={<>
        <button type="button" className="ghost-action" onClick={safeClose}
          disabled={saving}>Cancelar</button>
        <button type="submit" form="farm-form" className="primary-action"
          disabled={!editable}>{saving ? 'Guardando…' : 'Crear'}</button>
      </>}
    >
      <form id="farm-form" onSubmit={handleSubmit} style={{ display: 'contents' }}>
        {dataMode !== 'live' && <p role="status">Vista demo. No se crean establecimientos reales.</p>}
        {!authority && dataMode === 'live' &&
          <p role="alert">La sesión no permite crear establecimientos.</p>}
        {producersLoading && <p role="status">Cargando productores autorizados…</p>}
        {producersError && <ResourceLoadNotice title="productores" error={producersError}
          onRetry={() => setRetry(value => value + 1)} />}
        {error && <div className="auth-error" role="alert"><span>{error}</span></div>}
        {submitStatus === 'uncertain' && authority && (
          <button type="button" className="ghost-action" onClick={retrySame} disabled={saving}>
            Reintentar el mismo envío
          </button>
        )}

        <label className="form-field">
          <span>Nombre del establecimiento *</span>
          <input id="farm-name" value={form.name} onChange={set('name')}
            disabled={!editable} required minLength={2} maxLength={180} placeholder="La Esperanza" />
        </label>
        <div className="form-row">
          <label className="form-field">
            <span>Localidad</span>
            <input id="farm-locality" value={form.locality} onChange={set('locality')}
              disabled={!editable} placeholder="Pergamino" />
          </label>
          <label className="form-field">
            <span>Provincia</span>
            <input id="farm-province" value={form.province} onChange={set('province')}
              disabled={!editable} placeholder="Buenos Aires" />
          </label>
        </div>
        {producers.length > 0 && (
          <label className="form-field">
            <span>Productor (opcional)</span>
            <select id="farm-producer" value={form.producer_id} onChange={set('producer_id')}
              disabled={!editable}>
              <option value="">Sin productor asignado</option>
              {producers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        )}
        <label className="form-field">
          <span>Notas</span>
          <textarea id="farm-notes" value={form.notes} onChange={set('notes')}
            disabled={!editable} rows={2} placeholder="Observaciones del establecimiento…" />
        </label>
      </form>
    </Modal>
  );
}
