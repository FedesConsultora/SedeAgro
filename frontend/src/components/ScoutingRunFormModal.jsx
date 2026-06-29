import { useEffect, useState } from 'react';
import { useSession } from '../context/SessionContext.jsx';
import { Modal } from './Modal.jsx';
import { mockData } from '../services/mockData.js';

export function ScoutingRunFormModal({ isOpen, onClose, onCreated }) {
  const { api, dataMode } = useSession();
  const [campaignFields, setCampaignFields] = useState([]);
  const [form, setForm] = useState({ campaign_field_id: '', scheduled_at: '', status: 'planned', summary: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    const load = async () => {
      if (dataMode === 'mock') { setCampaignFields(mockData.campaignFields); return; }
      try {
        const res = await api.campaignFields();
        setCampaignFields(res.data || []);
      } catch {
        setCampaignFields(mockData.campaignFields);
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
      if (dataMode === 'mock') { onCreated(); return; }
      await api.createScoutingRun({
        campaign_field_id: form.campaign_field_id,
        scheduled_at: form.scheduled_at || undefined,
        status: form.status,
        summary: form.summary || undefined
      });
      onCreated();
    } catch (err) {
      setError(err?.message || 'Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Nueva recorrida de monitoreo"
      footer={<>
        <button type="button" className="ghost-action" onClick={onClose}>Cancelar</button>
        <button type="submit" form="scouting-run-form" className="primary-action" disabled={saving}>
          {saving ? 'Guardando…' : 'Crear recorrida'}
        </button>
      </>}
    >
      <form id="scouting-run-form" onSubmit={handleSubmit} style={{ display: 'contents' }}>
        {error && <div className="auth-error" style={{ marginBottom: 0 }}><span>{error}</span></div>}

        <label className="form-field">
          <span>Lote / Campaña *</span>
          <select id="srun-cf" value={form.campaign_field_id} onChange={set('campaign_field_id')} required>
            <option value="">Seleccioná lote y campaña</option>
            {campaignFields.map((cf) => (
              <option key={cf.id} value={cf.id}>
                {cf.Field?.name || 'Lote'} — {cf.Campaign?.name || 'Campaña'} ({cf.CropType?.name || '–'})
              </option>
            ))}
          </select>
        </label>

        <div className="form-row">
          <label className="form-field">
            <span>Fecha planificada</span>
            <input id="srun-date" type="datetime-local" value={form.scheduled_at} onChange={set('scheduled_at')} />
          </label>
          <label className="form-field">
            <span>Estado inicial</span>
            <select id="srun-status" value={form.status} onChange={set('status')}>
              <option value="planned">Planificado</option>
              <option value="in_progress">En curso</option>
            </select>
          </label>
        </div>

        <label className="form-field">
          <span>Descripción / resumen</span>
          <textarea id="srun-summary" value={form.summary} onChange={set('summary')} rows={2}
            placeholder="Recorrida por estado sanitario y malezas…" />
        </label>
      </form>
    </Modal>
  );
}
