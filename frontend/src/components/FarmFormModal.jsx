import { useEffect, useState } from 'react';
import { useSession } from '../context/SessionContext.jsx';
import { Modal } from './Modal.jsx';
import { ResourceLoadNotice } from './ResourceLoadNotice.jsx';
import { mockData } from '../services/mockData.js';

export function FarmFormModal({ isOpen, onClose, onCreated }) {
  const { api, dataMode } = useSession();
  const [producers, setProducers] = useState([]);
  const [producersLoading, setProducersLoading] = useState(false);
  const [producersError, setProducersError] = useState(null);
  const [retry, setRetry] = useState(0);
  const [form, setForm] = useState({ name: '', locality: '', province: '', country: 'Argentina', producer_id: '', notes: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen) return undefined;
    let cancelled = false;
    setProducers([]);
    setProducersError(null);
    setProducersLoading(true);
    const load = async () => {
      try {
        if (dataMode === 'mock') {
          if (!cancelled) setProducers(mockData.producers);
          return;
        }
        const response = await api.producers();
        if (!Array.isArray(response?.data)) throw new Error('Lista de productores inválida.');
        if (!cancelled) setProducers(response.data);
      } catch (error) {
        if (!cancelled) setProducersError(error?.message || 'No se pudieron consultar los productores.');
      } finally {
        if (!cancelled) setProducersLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [isOpen, api, dataMode, retry]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (producersLoading || producersError) return;
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
        <button type="submit" form="farm-form" className="primary-action" disabled={saving || producersLoading || Boolean(producersError)}>{saving ? 'Guardando…' : 'Crear'}</button>
      </>}
    >
      <form id="farm-form" onSubmit={handleSubmit} style={{ display: 'contents' }}>
        {producersLoading && <p role="status">Cargando productores autorizados…</p>}
        {producersError && <ResourceLoadNotice title="productores" error={producersError}
          onRetry={() => setRetry(value => value + 1)} />}
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
