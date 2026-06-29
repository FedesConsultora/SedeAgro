import { useEffect, useState } from 'react';
import { useSession } from '../context/SessionContext.jsx';
import { Modal } from './Modal.jsx';
import { mockData } from '../services/mockData.js';

export function FieldFormModal({ isOpen, onClose, onCreated, farmId: preselectedFarmId, farmName }) {
  const { api, dataMode } = useSession();
  const [farms, setFarms] = useState([]);
  const [form, setForm] = useState({
    farm_id: preselectedFarmId || '',
    name: '',
    area_hectares: '',
    status: 'active',
    notes: ''
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    const load = async () => {
      if (dataMode === 'mock') { setFarms(mockData.farms); return; }
      try { const res = await api.farms(); setFarms(res.data || []); } catch { setFarms(mockData.farms); }
    };
    load();
    if (preselectedFarmId) setForm((f) => ({ ...f, farm_id: preselectedFarmId }));
  }, [isOpen, api, dataMode, preselectedFarmId]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const body = { ...form, area_hectares: Number(form.area_hectares) || 0 };
      if (dataMode === 'mock') { onCreated(body); return; }
      await api.createField(body);
      onCreated();
    } catch (err) {
      setError(err?.message || 'Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose}
      title={farmName ? `Nuevo lote en ${farmName}` : 'Nuevo lote'}
      footer={<>
        <button type="button" className="ghost-action" onClick={onClose}>Cancelar</button>
        <button type="submit" form="field-form" className="primary-action" disabled={saving}>{saving ? 'Guardando…' : 'Crear lote'}</button>
      </>}
    >
      <form id="field-form" onSubmit={handleSubmit} style={{ display: 'contents' }}>
        {error && <div className="auth-error" style={{ marginBottom: 0 }}><span>{error}</span></div>}

        {!preselectedFarmId && (
          <label className="form-field">
            <span>Establecimiento *</span>
            <select id="field-farm" value={form.farm_id} onChange={set('farm_id')} required>
              <option value="">Seleccioná un establecimiento</option>
              {farms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </label>
        )}

        <label className="form-field">
          <span>Nombre del lote *</span>
          <input id="field-name" value={form.name} onChange={set('name')} required minLength={1} maxLength={180} placeholder="Lote 4 Norte" />
        </label>

        <div className="form-row">
          <label className="form-field">
            <span>Hectáreas</span>
            <input id="field-ha" type="number" min="0" step="0.01" value={form.area_hectares} onChange={set('area_hectares')} placeholder="82.5" />
          </label>
          <label className="form-field">
            <span>Estado</span>
            <select id="field-status" value={form.status} onChange={set('status')}>
              <option value="active">Activo</option>
              <option value="inactive">Inactivo</option>
              <option value="archived">Archivado</option>
            </select>
          </label>
        </div>

        <label className="form-field">
          <span>Notas</span>
          <textarea id="field-notes" value={form.notes} onChange={set('notes')} rows={2} placeholder="Observaciones del lote…" />
        </label>
      </form>
    </Modal>
  );
}
