import { useEffect, useRef, useState } from 'react';
import { useSession } from '../context/SessionContext.jsx';
import { Modal } from './Modal.jsx';
import {
  campaignFieldAssignScope, createCampaignFieldAssignGate,
  prepareCampaignFieldAssignment, verifyAssignedCampaignField
} from '../services/campaignFieldAssignSafety.js';

const emptyForm = () => ({
  field_id: '', crop_type_id: '', crop_variety_id: '',
  planting_date: '', harvest_target_date: '', expected_yield: '', status: 'planned'
});

export function AssignFieldModal({ isOpen, onClose, onCreated, campaignId, campaignName }) {
  const { api, dataMode, session } = useSession();
  const authority = campaignFieldAssignScope(session, dataMode, campaignId);
  const scopeRef = useRef(authority);
  scopeRef.current = authority;
  const apiRef = useRef(api);
  apiRef.current = api;
  const openRef = useRef(isOpen);
  openRef.current = isOpen;
  const submitGate = useRef(null);
  if (!submitGate.current) submitGate.current = createCampaignFieldAssignGate();

  const [optionsSnapshot, setOptionsSnapshot] = useState(null);
  const options = optionsSnapshot?.scope === authority && optionsSnapshot?.api === api
    ? optionsSnapshot : null;
  const fields = options?.phase === 'ready' ? options.fields : [];
  const cropTypes = options?.phase === 'ready' ? options.cropTypes : [];
  const loading = Boolean(isOpen && authority && (!options || options.phase === 'loading'));
  const optionsError = options?.phase === 'error' ? options.error : '';
  const [reload, setReload] = useState(0);
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
    setOptionsSnapshot({
      scope: requestScope, api: requestApi, phase: 'loading',
      fields: [], cropTypes: [], error: ''
    });
    const load = async () => {
      try {
        const [fieldReply, catalogReply] = await Promise.all([
          requestApi.fields(), requestApi.request('/catalogs/bootstrap')
        ]);
        const fetchedFields = fieldReply?.data;
        const fetchedCrops = catalogReply?.cropTypes;
        if (!Array.isArray(fetchedFields) ||
            fetchedFields.some(item => !item || typeof item.id !== 'string' ||
              (item.tenant_id && item.tenant_id !== session?.tenant?.id)) ||
            !Array.isArray(fetchedCrops) ||
            fetchedCrops.some(item => !item || typeof item.id !== 'string' ||
              !Array.isArray(item.CropVarieties ?? item.cropVarieties ?? []))) {
          throw new Error('El servidor devolvió un catálogo de lotes o cultivos inválido.');
        }
        if (current()) setOptionsSnapshot({
          scope: requestScope, api: requestApi, phase: 'ready',
          fields: fetchedFields, cropTypes: fetchedCrops, error: ''
        });
      } catch (err) {
        if (current()) setOptionsSnapshot({
          scope: requestScope, api: requestApi, phase: 'error',
          fields: [], cropTypes: [],
          error: err?.message || 'No se pudieron consultar los lotes y cultivos.'
        });
      }
    };
    void load();
    return () => { active = false; };
  }, [isOpen, authority, api, reload, session?.tenant?.id]);

  const safeClose = () => {
    if (submitGate.current.isPending(authority)) return;
    onClose?.();
  };
  const blocked = saving || submitStatus !== '' || submitGate.current.isBlocked(authority);
  const editable = Boolean(authority) && options?.phase === 'ready' && !blocked;
  const set = (key) => (event) => {
    if (!editable) return;
    const value = event.target.value;
    setFormSnapshot(snapshot => {
      const prior = snapshot?.scope === authority && snapshot?.api === api
        ? snapshot.value : emptyForm();
      return { scope: authority, api, value: {
        ...prior, [key]: value,
        ...(key === 'crop_type_id' ? { crop_variety_id: '' } : {})
      } };
    });
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!isOpen || !authority || options?.phase !== 'ready') return;
    let body;
    try {
      body = prepareCampaignFieldAssignment(form, fields, cropTypes, session?.tenant?.id);
    } catch (err) {
      setError(err?.message || 'Revisá los datos de asignación.');
      return;
    }
    const ticket = submitGate.current.acquire(authority);
    if (!ticket) return;
    const requestApi = api;
    const current = () => openRef.current && scopeRef.current === authority &&
      apiRef.current === requestApi && submitGate.current.isCurrent(ticket);
    setSaving(true);
    setError('');
    let confirmed = false;
    try {
      const response = await requestApi.assignCampaignField(campaignId, body);
      if (!current()) return;
      verifyAssignedCampaignField(response, body, session?.tenant?.id, campaignId);
      submitGate.current.finish(ticket, 'confirmed');
      setSubmitStatus('confirmed');
      confirmed = true;
    } catch (err) {
      if (!current()) return;
      // Once dispatched, transport errors can still follow a committed row.
      submitGate.current.finish(ticket, 'uncertain');
      setSubmitStatus('uncertain');
      setError('No pudimos confirmar si el lote quedó asignado. Cerrá este formulario, actualizá la campaña y revisá antes de intentar otra vez.');
    } finally {
      if (current()) setSaving(false);
    }
    if (confirmed && current()) onCreated?.();
  };

  const crop = cropTypes.find(item => item.id === form.crop_type_id);
  const varieties = crop?.CropVarieties ?? crop?.cropVarieties ?? [];

  return (
    <Modal isOpen={isOpen} onClose={safeClose}
      title={'Asignar lote a ' + (campaignName || 'campaña')}
      footer={<>
        <button type="button" className="ghost-action" onClick={safeClose} disabled={saving}>Cancelar</button>
        <button type="submit" form="assign-field-form" className="primary-action" disabled={!editable}>
          {saving ? 'Asignando…' : submitStatus === 'uncertain' ? 'Confirmación pendiente' : 'Asignar lote'}
        </button>
      </>}
    >
      <form id="assign-field-form" onSubmit={handleSubmit} style={{ display: 'contents' }}>
        {dataMode !== 'live' && <p role="status">Vista demo. No se asignan lotes reales.</p>}
        {!authority && dataMode === 'live' && <p role="alert">Esta sesión no permite asignar lotes.</p>}
        {loading && <p role="status">Cargando lotes y cultivos…</p>}
        {optionsError && <div className="auth-error" role="alert">
          <span>{optionsError}</span>
          <button type="button" onClick={() => setReload(value => value + 1)}>Reintentar carga</button>
        </div>}
        {error && <div role="alert" className="auth-error"><span>{error}</span></div>}

        <label className="form-field">
          <span>Lote *</span>
          <select id="assign-field" value={form.field_id} onChange={set('field_id')}
            disabled={!editable} required>
            <option value="">Seleccioná un lote</option>
            {fields.map(field => (
              <option key={field.id} value={field.id}>
                {field.name} {field.Farm ? '— ' + field.Farm.name : ''}
                {field.area_hectares ? ' (' + field.area_hectares + ' ha)' : ''}
              </option>
            ))}
          </select>
        </label>

        <div className="form-row">
          <label className="form-field">
            <span>Cultivo *</span>
            <select id="assign-crop" value={form.crop_type_id} onChange={set('crop_type_id')}
              disabled={!editable} required>
              <option value="">Seleccioná cultivo</option>
              {cropTypes.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          {varieties.length > 0 && (
            <label className="form-field">
              <span>Variedad</span>
              <select id="assign-variety" value={form.crop_variety_id} onChange={set('crop_variety_id')}
                disabled={!editable}>
                <option value="">Sin variedad específica</option>
                {varieties.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
          )}
        </div>

        <div className="form-row">
          <label className="form-field">
            <span>Fecha de siembra</span>
            <input id="assign-planting" type="date" value={form.planting_date}
              onChange={set('planting_date')} disabled={!editable} />
          </label>
          <label className="form-field">
            <span>Fecha est. cosecha</span>
            <input id="assign-harvest" type="date" value={form.harvest_target_date}
              onChange={set('harvest_target_date')} disabled={!editable} />
          </label>
        </div>

        <div className="form-row">
          <label className="form-field">
            <span>Rendimiento esperado (qq/ha)</span>
            <input id="assign-yield" type="number" min="0" step="0.01" value={form.expected_yield}
              onChange={set('expected_yield')} disabled={!editable} placeholder="38" />
          </label>
          <label className="form-field">
            <span>Estado</span>
            <select id="assign-status" value={form.status} onChange={set('status')} disabled={!editable}>
              <option value="planned">Planificado</option>
              <option value="active">Activo</option>
            </select>
          </label>
        </div>
      </form>
    </Modal>
  );
}
