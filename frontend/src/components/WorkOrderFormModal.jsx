import { useEffect, useState } from 'react';
import { useSession } from '../context/SessionContext.jsx';
import { Modal } from './Modal.jsx';
import { ResourceLoadNotice } from './ResourceLoadNotice.jsx';
import { mockData } from '../services/mockData.js';

export function WorkOrderFormModal({ isOpen, onClose, onCreated }) {
  const { api, dataMode } = useSession();
  const [fields, setFields] = useState([]);
  const [fieldsLoading, setFieldsLoading] = useState(false);
  const [fieldsError, setFieldsError] = useState(null);
  const [revision, setRevision] = useState(0);
  const [form, setForm] = useState({
    field_id: '',
    type: 'application',
    priority: 'normal',
    title: '',
    instructions: '',
    due_at: ''
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen) return undefined;
    let cancelled = false;
    setFields([]);
    setFieldsLoading(true);
    setFieldsError(null);
    const load = async () => {
      try {
        if (dataMode === 'mock') {
          if (!cancelled) setFields(mockData.fields);
          return;
        }
        const response = await api.fields();
        if (!Array.isArray(response?.data)) throw new Error('Lista de lotes inválida.');
        if (!cancelled) setFields(response.data);
      } catch (error) {
        if (!cancelled) setFieldsError(error?.message || 'No se pudieron consultar los lotes.');
      } finally {
        if (!cancelled) setFieldsLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [isOpen, api, dataMode, revision]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (fieldsLoading || fieldsError || !fields.some(field => field.id === form.field_id)) return;
    setSaving(true);
    setError('');
    try {
      const body = { ...form, due_at: form.due_at || undefined };
      if (dataMode === 'mock') { onCreated(); return; }
      await api.createWorkOrder(body);
      onCreated();
    } catch (err) {
      setError(err?.message || 'Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Nueva orden de trabajo"
      footer={<>
        <button type="button" className="ghost-action" onClick={onClose}>Cancelar</button>
        <button type="submit" form="wo-form" className="primary-action" disabled={saving || fieldsLoading || Boolean(fieldsError) || fields.length === 0}>
          {saving ? 'Guardando…' : 'Crear orden'}
        </button>
      </>}
    >
      <form id="wo-form" onSubmit={handleSubmit} style={{ display: 'contents' }}>
        {fieldsLoading && <p role="status">Cargando lotes autorizados…</p>}
        {fieldsError && <ResourceLoadNotice title="lotes de la orden" error={fieldsError}
          onRetry={() => setRevision(value => value + 1)} />}
        {!fieldsLoading && !fieldsError && fields.length === 0 &&
          <p role="status">No hay lotes disponibles. Registrá un lote antes de crear la orden.</p>}
        {error && <div className="auth-error" style={{ marginBottom: 0 }}><span>{error}</span></div>}

        <label className="form-field">
          <span>Título de la orden *</span>
          <input id="wo-title" value={form.title} onChange={set('title')} required minLength={3}
            placeholder="Aplicación selectiva lote 4" />
        </label>

        <label className="form-field">
          <span>Lote *</span>
          <select id="wo-field" value={form.field_id} onChange={set('field_id')} required>
            <option value="">Seleccioná un lote</option>
            {fields.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name} {f.Farm ? `— ${f.Farm.name}` : ''}
              </option>
            ))}
          </select>
        </label>

        <div className="form-row">
          <label className="form-field">
            <span>Tipo de tarea *</span>
            <select id="wo-type" value={form.type} onChange={set('type')}>
              <option value="application">Aplicación</option>
              <option value="sowing">Siembra</option>
              <option value="fertilization">Fertilización</option>
              <option value="harvest">Cosecha</option>
              <option value="irrigation">Riego</option>
              <option value="inspection">Inspección</option>
              <option value="other">Otro</option>
            </select>
          </label>
          <label className="form-field">
            <span>Prioridad</span>
            <select id="wo-priority" value={form.priority} onChange={set('priority')}>
              <option value="low">Baja</option>
              <option value="normal">Normal</option>
              <option value="high">Alta</option>
              <option value="urgent">Urgente</option>
            </select>
          </label>
        </div>

        <label className="form-field">
          <span>Fecha límite</span>
          <input id="wo-due" type="datetime-local" value={form.due_at} onChange={set('due_at')} />
        </label>

        <label className="form-field">
          <span>Instrucciones</span>
          <textarea id="wo-instructions" value={form.instructions} onChange={set('instructions')} rows={3}
            placeholder="Controlar cabecera norte y registrar evidencia fotográfica…" />
        </label>
      </form>
    </Modal>
  );
}
