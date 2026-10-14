import { useEffect, useState } from 'react';
import { useSession } from '../context/SessionContext.jsx';
import { Modal } from './Modal.jsx';
import { mockData } from '../services/mockData.js';

export function FieldFormModal({ isOpen, onClose, onCreated, farmId: preselectedFarmId, farmName }) {
  const { api, dataMode, session } = useSession();
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
  const [farmLoadError, setFarmLoadError] = useState('');
  const [loadingFarms, setLoadingFarms] = useState(false);
  const [farmLoadRevision, setFarmLoadRevision] = useState(0);

  useEffect(() => {
    if (!isOpen) return undefined;
    let cancelled = false;
    setFarmLoadError('');
    setError('');
    setFarms([]);
    setForm((current) => ({ ...current, farm_id: preselectedFarmId || '' }));
    if (preselectedFarmId) {
      setLoadingFarms(false);
      return () => { cancelled = true; };
    }
    if (dataMode === 'mock') {
      setFarms(mockData.farms);
      setLoadingFarms(false);
      return () => { cancelled = true; };
    }
    if (!session?.authenticated || !session?.tenant?.id || !session?.user?.id) {
      setFarmLoadError('No hay una sesión válida para consultar establecimientos.');
      setLoadingFarms(false);
      return () => { cancelled = true; };
    }
    setLoadingFarms(true);
    Promise.resolve().then(() => api.farms()).then((res) => {
      if (!Array.isArray(res?.data)) {
        throw new Error('La lista de establecimientos del servidor no es válida.');
      }
      if (!cancelled) setFarms(res.data);
    }).catch((err) => {
      if (!cancelled) {
        setFarms([]);
        setFarmLoadError(err?.message || 'No se pudieron consultar establecimientos.');
      }
    }).finally(() => { if (!cancelled) setLoadingFarms(false); });
    return () => { cancelled = true; };
  }, [isOpen, api, dataMode, preselectedFarmId, farmLoadRevision,
      session?.authenticated, session?.tenant?.id, session?.user?.id]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      if (dataMode === 'live' && !preselectedFarmId &&
          (loadingFarms || farmLoadError || !farms.some((farm) => farm.id === form.farm_id))) {
        throw new Error('Seleccioná un establecimiento válido de esta sesión antes de crear el lote.');
      }
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
        <button type="submit" form="field-form" className="primary-action"
          disabled={saving || (dataMode === 'live' && !preselectedFarmId &&
            (loadingFarms || Boolean(farmLoadError) || farms.length === 0))}>
          {saving ? 'Guardando…' : 'Crear lote'}
        </button>
      </>}
    >
      <form id="field-form" onSubmit={handleSubmit} style={{ display: 'contents' }}>
        {error && <div role="alert" className="auth-error" style={{ marginBottom: 0 }}><span>{error}</span></div>}
        {farmLoadError && <div role="alert" className="auth-error">
          {farmLoadError}
          <button type="button" onClick={() => setFarmLoadRevision(value => value + 1)}>Reintentar</button>
        </div>}

        {!preselectedFarmId && (
          <label className="form-field">
            <span>Establecimiento *</span>
            <select id="field-farm" value={form.farm_id} onChange={set('farm_id')}
              disabled={loadingFarms || Boolean(farmLoadError)} required>
              <option value="">{loadingFarms ? 'Cargando establecimientos…' : 'Seleccioná un establecimiento'}</option>
              {farms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
            {!loadingFarms && !farmLoadError && farms.length === 0 &&
              <small>No hay establecimientos disponibles en esta cuenta.</small>}
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
