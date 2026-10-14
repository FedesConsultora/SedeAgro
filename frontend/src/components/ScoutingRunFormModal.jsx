import { useEffect, useState } from 'react';
import { useSession } from '../context/SessionContext.jsx';
import { Modal } from './Modal.jsx';
import { mockData } from '../services/mockData.js';

export function ScoutingRunFormModal({ isOpen, onClose, onCreated }) {
  const { api, dataMode } = useSession();
  const [campaignFields, setCampaignFields] = useState([]);
  const [assignees, setAssignees] = useState([]);
  const [form, setForm] = useState({
    campaign_field_id: '', assigned_to: '', scheduled_at: '', status: 'planned', summary: ''
  });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [optionsError, setOptionsError] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    async function load() {
      if (dataMode === 'mock') {
        setCampaignFields(mockData.campaignFields);
        setAssignees([]);
        setOptionsError('');
        return;
      }
      setLoading(true);
      try {
        const [fields, people] = await Promise.all([api.campaignFields(), api.scoutingAssignees()]);
        if (cancelled) return;
        setCampaignFields(fields.data || []);
        setAssignees(people.data || []);
        setOptionsError('');
      } catch (err) {
        if (cancelled) return;
        setCampaignFields([]);
        setAssignees([]);
        setOptionsError(err?.message || 'No se pudieron consultar lotes y responsables.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [isOpen, api, dataMode]);

  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const handleSubmit = async (event) => {
    event.preventDefault();
    if (dataMode !== 'live') {
      setError('Para crear una recorrida, conectá el backend.');
      return;
    }
    if (form.status === 'in_progress' && !form.assigned_to) {
      setError('Seleccioná un responsable antes de iniciar una recorrida.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await api.createScoutingRun({
        campaign_field_id: form.campaign_field_id,
        assigned_to: form.assigned_to || null,
        scheduled_at: form.scheduled_at ? new Date(form.scheduled_at).toISOString() : undefined,
        status: form.status,
        summary: form.summary || undefined
      });
      onCreated?.();
    } catch (err) {
      setError(err?.message || 'No se pudo crear la recorrida.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Nueva recorrida de monitoreo"
      footer={<>
        <button type="button" className="ghost-action" onClick={onClose} disabled={saving}>Cancelar</button>
        <button type="submit" form="scouting-run-form" className="primary-action"
          disabled={saving || loading || Boolean(optionsError) || dataMode !== 'live'}>
          {saving ? 'Guardando…' : 'Crear recorrida'}
        </button>
      </>}
    >
      <form id="scouting-run-form" onSubmit={handleSubmit} style={{ display: 'grid', gap: 14 }}>
        {(error || optionsError) && <div className="auth-error" role="alert"><span>{error || optionsError}</span></div>}
        <label className="form-field">
          <span>Lote / campaña *</span>
          <select value={form.campaign_field_id} onChange={set('campaign_field_id')} disabled={loading || saving} required>
            <option value="">Seleccioná lote y campaña</option>
            {campaignFields.map((field) => (
              <option key={field.id} value={field.id}>
                {field.Field?.name || 'Lote'} — {field.Campaign?.name || 'Campaña'} ({field.CropType?.name || '–'})
              </option>
            ))}
          </select>
        </label>
        <label className="form-field">
          <span>Responsable</span>
          <select value={form.assigned_to} onChange={set('assigned_to')} disabled={loading || saving}>
            <option value="">Sin asignar (solo planificada)</option>
            {assignees.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name} · {person.role_code === 'scout' ? 'Monitoreador' : 'Coordinador'}
              </option>
            ))}
          </select>
        </label>
        {dataMode === 'live' && assignees.length === 0 && !optionsError &&
          <p role="status" style={{ margin: 0, color: '#a16207', fontSize: 12 }}>
            No hay responsables activos. Podés planificar la recorrida sin asignarla, pero no iniciarla.
          </p>}
        <div className="form-row">
          <label className="form-field">
            <span>Fecha planificada</span>
            <input type="datetime-local" value={form.scheduled_at} onChange={set('scheduled_at')} disabled={saving}/>
          </label>
          <label className="form-field">
            <span>Estado inicial</span>
            <select value={form.status} onChange={set('status')} disabled={saving}>
              <option value="planned">Planificada</option>
              <option value="in_progress">En curso (requiere responsable)</option>
            </select>
          </label>
        </div>
        <label className="form-field">
          <span>Descripción de la recorrida</span>
          <textarea rows={3} maxLength={5000} value={form.summary} onChange={set('summary')}
            placeholder="Objetivo del monitoreo, sectores a revisar…" disabled={saving}/>
        </label>
        {dataMode !== 'live' && <p role="status" style={{ color: '#a16207', margin: 0 }}>
          Vista demo. Las recorridas solo pueden guardarse conectando el backend.
        </p>}
      </form>
    </Modal>
  );
}
