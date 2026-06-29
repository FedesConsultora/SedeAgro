import { useState } from 'react';
import { useSession } from '../context/SessionContext.jsx';
import { Modal } from './Modal.jsx';

export function ObservationFormModal({ isOpen, onClose, onCreated, runId }) {
  const { api, dataMode } = useSession();
  const [form, setForm] = useState({
    observation_type: 'weed',
    severity: 'medium',
    observed_at: new Date().toISOString().slice(0, 16),
    notes: ''
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
      await api.createObservation(runId, {
        observation_type: form.observation_type,
        severity: form.severity,
        observed_at: form.observed_at || undefined,
        notes: form.notes || undefined
      });
      onCreated();
    } catch (err) {
      setError(err?.message || 'Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Agregar observación"
      footer={<>
        <button type="button" className="ghost-action" onClick={onClose}>Cancelar</button>
        <button type="submit" form="obs-form" className="primary-action" disabled={saving}>
          {saving ? 'Guardando…' : 'Registrar'}
        </button>
      </>}
    >
      <form id="obs-form" onSubmit={handleSubmit} style={{ display: 'contents' }}>
        {error && <div className="auth-error" style={{ marginBottom: 0 }}><span>{error}</span></div>}

        <div className="form-row">
          <label className="form-field">
            <span>Tipo de observación *</span>
            <select id="obs-type" value={form.observation_type} onChange={set('observation_type')}>
              <option value="weed">Maleza</option>
              <option value="pest">Plaga</option>
              <option value="disease">Enfermedad</option>
              <option value="phenology">Fenología</option>
              <option value="nutrition">Nutrición</option>
              <option value="water">Agua</option>
              <option value="general">General</option>
            </select>
          </label>
          <label className="form-field">
            <span>Severidad *</span>
            <select id="obs-severity" value={form.severity} onChange={set('severity')}>
              <option value="low">Leve</option>
              <option value="medium">Moderado</option>
              <option value="high">Alto</option>
              <option value="critical">Crítico</option>
            </select>
          </label>
        </div>

        <label className="form-field">
          <span>Fecha / hora de observación</span>
          <input id="obs-date" type="datetime-local" value={form.observed_at} onChange={set('observed_at')} />
        </label>

        <label className="form-field">
          <span>Notas *</span>
          <textarea id="obs-notes" value={form.notes} onChange={set('notes')} required rows={3}
            placeholder="Descripción de lo observado en el lote…" />
        </label>
      </form>
    </Modal>
  );
}
