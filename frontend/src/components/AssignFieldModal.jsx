import { useEffect, useState } from 'react';
import { useSession } from '../context/SessionContext.jsx';
import { Modal } from './Modal.jsx';
import { mockData } from '../services/mockData.js';

export function AssignFieldModal({ isOpen, onClose, onCreated, campaignId, campaignName }) {
  const { api, dataMode } = useSession();
  const [fields, setFields] = useState([]);
  const [cropTypes, setCropTypes] = useState([]);
  const [form, setForm] = useState({
    field_id: '',
    crop_type_id: '',
    crop_variety_id: '',
    planting_date: '',
    harvest_target_date: '',
    expected_yield: '',
    status: 'planned'
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    const load = async () => {
      if (dataMode === 'mock') {
        setFields(mockData.fields);
        setCropTypes(mockData.cropTypes);
        return;
      }
      try {
        const [fieldsRes, catalogRes] = await Promise.all([
          api.fields(),
          api.request('/catalogs/bootstrap')
        ]);
        setFields(fieldsRes.data || []);
        setCropTypes(catalogRes.cropTypes || []);
      } catch {
        setFields(mockData.fields);
        setCropTypes(mockData.cropTypes);
      }
    };
    load();
  }, [isOpen, api, dataMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const body = {
        field_id: form.field_id,
        crop_type_id: form.crop_type_id,
        crop_variety_id: form.crop_variety_id || undefined,
        planting_date: form.planting_date || undefined,
        harvest_target_date: form.harvest_target_date || undefined,
        expected_yield: form.expected_yield ? Number(form.expected_yield) : undefined,
        status: form.status
      };
      if (dataMode === 'mock') { onCreated(); return; }
      await api.assignCampaignField(campaignId, body);
      onCreated();
    } catch (err) {
      setError(err?.message || 'Error al asignar lote');
    } finally {
      setSaving(false);
    }
  };

  const selectedCrop = cropTypes.find((c) => c.id === form.crop_type_id);
  const varieties = selectedCrop?.CropVarieties || selectedCrop?.cropVarieties || [];

  return (
    <Modal isOpen={isOpen} onClose={onClose}
      title={`Asignar lote a ${campaignName || 'campaña'}`}
      footer={<>
        <button type="button" className="ghost-action" onClick={onClose}>Cancelar</button>
        <button type="submit" form="assign-field-form" className="primary-action" disabled={saving}>
          {saving ? 'Asignando…' : 'Asignar lote'}
        </button>
      </>}
    >
      <form id="assign-field-form" onSubmit={handleSubmit} style={{ display: 'contents' }}>
        {error && <div className="auth-error" style={{ marginBottom: 0 }}><span>{error}</span></div>}

        <label className="form-field">
          <span>Lote *</span>
          <select id="assign-field" value={form.field_id} onChange={set('field_id')} required>
            <option value="">Seleccioná un lote</option>
            {fields.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name} {f.Farm ? `— ${f.Farm.name}` : ''} {f.area_hectares ? `(${f.area_hectares} ha)` : ''}
              </option>
            ))}
          </select>
        </label>

        <div className="form-row">
          <label className="form-field">
            <span>Cultivo *</span>
            <select id="assign-crop" value={form.crop_type_id} onChange={set('crop_type_id')} required>
              <option value="">Seleccioná cultivo</option>
              {cropTypes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          {varieties.length > 0 && (
            <label className="form-field">
              <span>Variedad</span>
              <select id="assign-variety" value={form.crop_variety_id} onChange={set('crop_variety_id')}>
                <option value="">Sin variedad específica</option>
                {varieties.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </label>
          )}
        </div>

        <div className="form-row">
          <label className="form-field">
            <span>Fecha de siembra</span>
            <input id="assign-planting" type="date" value={form.planting_date} onChange={set('planting_date')} />
          </label>
          <label className="form-field">
            <span>Fecha est. cosecha</span>
            <input id="assign-harvest" type="date" value={form.harvest_target_date} onChange={set('harvest_target_date')} />
          </label>
        </div>

        <div className="form-row">
          <label className="form-field">
            <span>Rendimiento esperado (qq/ha)</span>
            <input id="assign-yield" type="number" min="0" step="0.1" value={form.expected_yield} onChange={set('expected_yield')} placeholder="38" />
          </label>
          <label className="form-field">
            <span>Estado</span>
            <select id="assign-status" value={form.status} onChange={set('status')}>
              <option value="planned">Planificado</option>
              <option value="active">Activo</option>
            </select>
          </label>
        </div>
      </form>
    </Modal>
  );
}
