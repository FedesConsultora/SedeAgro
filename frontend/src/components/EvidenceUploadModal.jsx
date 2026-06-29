import { useState } from 'react';
import { useSession } from '../context/SessionContext.jsx';
import { Modal } from './Modal.jsx';

const MIME_OPTIONS = [
  { value: 'image/jpeg', label: 'Foto (JPEG)' },
  { value: 'image/png', label: 'Foto (PNG)' },
  { value: 'audio/mpeg', label: 'Audio (MP3)' },
  { value: 'application/pdf', label: 'Documento (PDF)' },
  { value: 'video/mp4', label: 'Video (MP4)' }
];

export function EvidenceUploadModal({ isOpen, onClose, onCreated, observationId }) {
  const { api, dataMode } = useSession();
  const [form, setForm] = useState({
    evidence_type: 'photo',
    original_filename: '',
    mime_type: 'image/jpeg',
    storage_key: '',
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
      await api.createEvidence(observationId, {
        evidence_type: form.evidence_type,
        original_filename: form.original_filename,
        mime_type: form.mime_type,
        storage_key: form.storage_key,
        notes: form.notes || undefined
      });
      onCreated();
    } catch (err) {
      setError(err?.message || 'Error al registrar evidencia');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Adjuntar evidencia"
      footer={<>
        <button type="button" className="ghost-action" onClick={onClose}>Cancelar</button>
        <button type="submit" form="evidence-form" className="primary-action" disabled={saving}>
          {saving ? 'Guardando…' : 'Registrar evidencia'}
        </button>
      </>}
    >
      <form id="evidence-form" onSubmit={handleSubmit} style={{ display: 'contents' }}>
        {error && <div className="auth-error" style={{ marginBottom: 0 }}><span>{error}</span></div>}

        <div className="form-row">
          <label className="form-field">
            <span>Tipo de evidencia *</span>
            <select id="evid-type" value={form.evidence_type} onChange={set('evidence_type')}>
              <option value="photo">Foto</option>
              <option value="audio">Audio</option>
              <option value="document">Documento</option>
              <option value="video">Video</option>
            </select>
          </label>
          <label className="form-field">
            <span>Formato</span>
            <select id="evid-mime" value={form.mime_type} onChange={set('mime_type')}>
              {MIME_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
        </div>

        <label className="form-field">
          <span>Nombre de archivo *</span>
          <input id="evid-filename" value={form.original_filename} onChange={set('original_filename')} required
            placeholder="foto-lote-4-manchas.jpg" />
        </label>

        <label className="form-field">
          <span>URL / clave de almacenamiento *</span>
          <input id="evid-key" value={form.storage_key} onChange={set('storage_key')} required
            placeholder="https://... o s3://bucket/key" />
        </label>

        <label className="form-field">
          <span>Notas adicionales</span>
          <textarea id="evid-notes" value={form.notes} onChange={set('notes')} rows={2}
            placeholder="Sector norte, cabecera izquierda…" />
        </label>

        <div style={{ padding: '10px 14px', borderRadius: 8, background: 'rgba(14,165,233,0.06)', fontSize: 12, color: '#0c4a6e' }}>
          ℹ️ En esta versión, el archivo no se sube automáticamente. Registrá la URL o clave del archivo ya alojado.
        </div>
      </form>
    </Modal>
  );
}
