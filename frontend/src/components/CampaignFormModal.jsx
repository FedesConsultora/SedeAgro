import { useState } from 'react';
import { useSession } from '../context/SessionContext.jsx';
import { Modal } from './Modal.jsx';

export function CampaignFormModal({ isOpen, onClose, onCreated }) {
  const { api, dataMode } = useSession();
  const thisYear = new Date().getFullYear();
  const [form, setForm] = useState({
    name: '',
    season_year: thisYear,
    starts_at: `${thisYear}-09-01`,
    ends_at: `${thisYear + 1}-07-31`,
    status: 'planned'
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      if (dataMode === 'mock') { onCreated(); return; }
      await api.createCampaign({ ...form, season_year: Number(form.season_year) });
      onCreated();
    } catch (err) {
      setError(err?.message || 'Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Nueva campaña"
      footer={<>
        <button type="button" className="ghost-action" onClick={onClose}>Cancelar</button>
        <button type="submit" form="campaign-form" className="primary-action" disabled={saving}>{saving ? 'Guardando…' : 'Crear campaña'}</button>
      </>}
    >
      <form id="campaign-form" onSubmit={handleSubmit} style={{ display: 'contents' }}>
        {error && <div className="auth-error" style={{ marginBottom: 0 }}><span>{error}</span></div>}

        <label className="form-field">
          <span>Nombre de la campaña *</span>
          <input id="campaign-name" value={form.name} onChange={set('name')} required minLength={2} placeholder="Campaña gruesa 2026/27" />
        </label>

        <div className="form-row">
          <label className="form-field">
            <span>Año de campaña *</span>
            <input id="campaign-year" type="number" min="2000" max="2100" value={form.season_year} onChange={set('season_year')} required />
          </label>
          <label className="form-field">
            <span>Estado</span>
            <select id="campaign-status" value={form.status} onChange={set('status')}>
              <option value="planned">Planificado</option>
              <option value="active">Activo</option>
              <option value="closed">Cerrado</option>
            </select>
          </label>
        </div>

        <div className="form-row">
          <label className="form-field">
            <span>Fecha inicio *</span>
            <input id="campaign-starts" type="date" value={form.starts_at} onChange={set('starts_at')} required />
          </label>
          <label className="form-field">
            <span>Fecha fin estimada</span>
            <input id="campaign-ends" type="date" value={form.ends_at} onChange={set('ends_at')} />
          </label>
        </div>
      </form>
    </Modal>
  );
}
