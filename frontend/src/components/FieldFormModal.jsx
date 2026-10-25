import { useEffect, useRef, useState } from 'react';
import { useSession } from '../context/SessionContext.jsx';
import { Modal } from './Modal.jsx';
import {
  fieldCreateScope, prepareFieldCreate, verifyCreatedField, createFieldSubmitGate
} from '../services/fieldCreateSafety.js';

function emptyForm(farmId) {
  return { farm_id: farmId || '', name: '', area_hectares: '',
    status: 'active', notes: '' };
}

export function FieldFormModal({ isOpen, onClose, onCreated, farmId: preselectedFarmId, farmName }) {
  const { api, dataMode, session } = useSession();
  const authority = fieldCreateScope(session, dataMode, preselectedFarmId);
  const scopeRef = useRef(authority);
  scopeRef.current = authority;
  const apiRef = useRef(api);
  apiRef.current = api;
  const openRef = useRef(isOpen);
  openRef.current = isOpen;
  const gate = useRef(null);
  if (!gate.current) gate.current = createFieldSubmitGate();

  const [farmSnapshot, setFarmSnapshot] = useState(null);
  const view = farmSnapshot?.scope === authority && farmSnapshot?.api === api
    ? farmSnapshot : null;
  const farms = view?.phase === 'ready' ? view.farms : [];
  const loading = Boolean(isOpen && authority && !preselectedFarmId &&
    (!view || view.phase === 'loading'));
  const farmLoadError = view?.phase === 'error' ? view.error : '';
  const [revision, setRevision] = useState(0);

  const [formSnapshot, setFormSnapshot] = useState(null);
  const form = formSnapshot?.scope === authority && formSnapshot?.api === api
    ? formSnapshot.value : emptyForm(preselectedFarmId);
  const [saving, setSaving] = useState(false);
  const [submitStatus, setSubmitStatus] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    gate.current.reset();
    setFarmSnapshot(null);
    setFormSnapshot({ scope: authority, api, value: emptyForm(preselectedFarmId) });
    setSaving(false);
    setSubmitStatus('');
    setError('');
    return () => { gate.current.reset(); };
  }, [isOpen, authority, api, preselectedFarmId]);

  useEffect(() => {
    if (!isOpen || !authority || preselectedFarmId) return undefined;
    let active = true;
    const requestScope = authority;
    const requestApi = api;
    const current = () => active && openRef.current &&
      scopeRef.current === requestScope && apiRef.current === requestApi;
    setFarmSnapshot({ scope: requestScope, api: requestApi,
      phase: 'loading', farms: [], error: '' });
    const load = async () => {
      try {
        const response = await requestApi.farms();
        const records = response?.data;
        if (!Array.isArray(records) || records.some(farm =>
          !farm || typeof farm.id !== 'string' ||
          (farm.tenant_id && farm.tenant_id !== session?.tenant?.id))) {
          throw new Error('El servidor devolvió establecimientos inválidos.');
        }
        if (current()) setFarmSnapshot({ scope: requestScope, api: requestApi,
          phase: 'ready', farms: records, error: '' });
      } catch (err) {
        if (current()) setFarmSnapshot({ scope: requestScope, api: requestApi,
          phase: 'error', farms: [],
          error: err?.message || 'No se pudieron consultar establecimientos.' });
      }
    };
    void load();
    return () => { active = false; };
  }, [isOpen, api, authority, preselectedFarmId, revision, session?.tenant?.id]);

  const safeClose = () => {
    if (gate.current.isPending(authority)) return;
    onClose?.();
  };
  const blocked = saving || submitStatus !== '' || gate.current.isBlocked(authority);
  const editable = Boolean(authority) && !blocked &&
    (Boolean(preselectedFarmId) || view?.phase === 'ready');
  const set = (key) => (event) => {
    if (!editable) return;
    const value = event.target.value;
    setFormSnapshot(snapshot => ({
      scope: authority, api,
      value: {
        ...(snapshot?.scope === authority && snapshot?.api === api
          ? snapshot.value : emptyForm(preselectedFarmId)),
        [key]: value
      }
    }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!isOpen || !editable) return;
    let body;
    try {
      body = prepareFieldCreate(form, farms, session?.tenant?.id, preselectedFarmId);
    } catch (err) {
      setError(err?.message || 'Revisá los datos del lote.');
      return;
    }
    const ticket = gate.current.acquire(authority);
    if (!ticket) return; // synchronous single flight, before any await
    const requestApi = api;
    const current = () => openRef.current && scopeRef.current === authority &&
      apiRef.current === requestApi && gate.current.isCurrent(ticket);
    setSaving(true);
    setError('');
    let confirmed = false;
    try {
      const response = await requestApi.createField(body);
      if (!current()) return;
      verifyCreatedField(response, body, session?.tenant?.id);
      gate.current.finish(ticket, 'confirmed');
      setSubmitStatus('confirmed');
      confirmed = true;
    } catch (err) {
      if (!current()) return;
      gate.current.finish(ticket, 'uncertain');
      setSubmitStatus('uncertain');
      setError('No pudimos confirmar si el lote quedó creado. Cerrá, actualizá Establecimientos y revisá antes de intentar otra vez.');
    } finally {
      if (current()) setSaving(false);
    }
    if (confirmed && current()) onCreated?.();
  };

  return (
    <Modal isOpen={isOpen} onClose={safeClose}
      title={farmName ? 'Nuevo lote en ' + farmName : 'Nuevo lote'}
      footer={<>
        <button type="button" className="ghost-action" onClick={safeClose} disabled={saving}>Cancelar</button>
        <button type="submit" form="field-form" className="primary-action" disabled={!editable}>
          {saving ? 'Guardando…' : submitStatus === 'uncertain' ? 'Confirmación pendiente' : 'Crear lote'}
        </button>
      </>}
    >
      <form id="field-form" onSubmit={handleSubmit} style={{ display: 'contents' }}>
        {dataMode !== 'live' && <p role="status">Vista demo. No se guardan lotes reales.</p>}
        {!authority && dataMode === 'live' && <p role="alert">Tu sesión no permite crear lotes.</p>}
        {loading && <p role="status">Cargando establecimientos…</p>}
        {farmLoadError && <div role="alert" className="auth-error">
          {farmLoadError}
          <button type="button" onClick={() => setRevision(value => value + 1)}>Reintentar</button>
        </div>}
        {error && <div role="alert" className="auth-error"><span>{error}</span></div>}
        {!preselectedFarmId && (
          <label className="form-field">
            <span>Establecimiento *</span>
            <select id="field-farm" value={form.farm_id} onChange={set('farm_id')}
              disabled={!editable} required>
              <option value="">Seleccioná un establecimiento</option>
              {farms.map(farm => <option key={farm.id} value={farm.id}>{farm.name}</option>)}
            </select>
            {!loading && !farmLoadError && farms.length === 0 &&
              <small>No hay establecimientos disponibles en esta cuenta.</small>}
          </label>
        )}
        <label className="form-field">
          <span>Nombre del lote *</span>
          <input id="field-name" value={form.name} onChange={set('name')} disabled={!editable}
            required minLength={1} maxLength={180} placeholder="Lote 4 Norte" />
        </label>
        <div className="form-row">
          <label className="form-field">
            <span>Hectáreas</span>
            <input id="field-ha" type="number" min="0" step="0.01"
              value={form.area_hectares} onChange={set('area_hectares')}
              disabled={!editable} placeholder="82.5" />
          </label>
          <label className="form-field">
            <span>Estado</span>
            <select id="field-status" value={form.status} onChange={set('status')} disabled={!editable}>
              <option value="active">Activo</option>
              <option value="inactive">Inactivo</option>
              <option value="archived">Archivado</option>
            </select>
          </label>
        </div>
        <label className="form-field">
          <span>Notas</span>
          <textarea id="field-notes" value={form.notes} onChange={set('notes')}
            disabled={!editable} rows={2} placeholder="Observaciones del lote…" />
        </label>
      </form>
    </Modal>
  );
}
