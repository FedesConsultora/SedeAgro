import { useEffect, useState } from 'react';
import { useSession } from '../context/SessionContext.jsx';
import { Modal } from './Modal.jsx';
import { mockData } from '../services/mockData.js';

export function FarmFormModal({ isOpen, onClose, onCreated }) {
  const { api, dataMode } = useSession();
  const [producers, setProducers] = useState([]);
  const [form, setForm] = useState({ name: '', locality: '', province: '', country: 'Argentina', producer_id: '', notes: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    const load = async () => {
      if (dataMode === 'mock') { setProducers(mockData.producers); return; }
      try { const res = await api.producers(); setProducers(res.data || []); } catch { setProducers(mockData.producers); }
    };
    load();
  }, [isOpen, api, dataMode]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const body = { ...form, producer_id: form.producer_id || null };
      if (dataMode === 'mock') { onCreated({ ...body, id: Date.now().toString(), Fields: [] }); return; }
      await api.createFarm(body);
      onCreated();
    } catch (err) {
      setError(err?.message || 'Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Nuevo establecimiento"
      footer={<>
        <button type="button" className="ghost-action" onClick={onClose}>Cancelar</button>
        <button type="submit" form="farm-form" className="primary-action" disabled={saving}>{saving ? 'Guardando…' : 'Crear'}</button>
      </>}
    >
      <form id="farm-form" onSubmit={handleSubmit} style={{ display: 'contents' }}>
        {error && <div className="auth-error" style={{ marginBottom: 0 }}><span>{error}</span></div>}

        <label className="form-field">
          <span>Nombre del establecimiento *</span>
          <input id="farm-name" value={form.name} onChange={set('name')} required minLength={2} maxLength={180} placeholder="La Esperanza" />
        </label>

        <div className="form-row">
          <label className="form-field">
            <span>Localidad</span>
            <input id="farm-locality" value={form.locality} onChange={set('locality')} placeholder="Pergamino" />
          </label>
          <label className="form-field">
            <span>Provincia</span>
            <input id="farm-province" value={form.province} onChange={set('province')} placeholder="Buenos Aires" />
          </label>
        </div>

        {producers.length > 0 && (
          <label className="form-field">
            <span>Productor (opcional)</span>
            <select id="farm-producer" value={form.producer_id} onChange={set('producer_id')}>
              <option value="">Sin productor asignado</option>
              {producers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        )}

        <label className="form-field">
          <span>Notas</span>
          <textarea id="farm-notes" value={form.notes} onChange={set('notes')} rows={2} placeholder="Observaciones del establecimiento…" />
        </label>
      </form>
    </Modal>
  );
}
