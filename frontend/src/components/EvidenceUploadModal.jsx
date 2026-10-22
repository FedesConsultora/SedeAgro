import { useEffect, useRef, useState } from 'react';
import { useSession } from '../context/SessionContext.jsx';
import { Modal } from './Modal.jsx';
import { sessionScope } from '../services/offlineSyncModel.js';
import { createMobileCaptureFence } from '../services/mobileCaptureSafety.js';
import { preparePrivateEvidenceUpload } from '../services/privateEvidenceUpload.js';

export function EvidenceUploadModal({ isOpen, onClose, onCreated, observationId }) {
  const { api, dataMode, session } = useSession();
  const [file, setFile] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const fence = useRef(null);
  if (!fence.current) fence.current = createMobileCaptureFence();
  const scope = isOpen && dataMode === 'live' && sessionScope(session)
    ? `${sessionScope(session)}:${observationId}` : null;
  // Closing the modal, changing a tenant or replacing the observation invalidates
  // asynchronous Canvas work before it can issue a private API request.
  fence.current.setScope(scope);
  useEffect(() => {
    fence.current.setScope(scope);
    return () => fence.current.invalidate();
  }, [scope]);
  useEffect(() => {
    setFile(null);
    setSaving(false);
    setError('');
  }, [scope]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');
    if (!scope) {
      setError('Iniciá sesión en la empresa para adjuntar evidencia privada.');
      return;
    }
    const ticket = fence.current.ticket();
    if (!fence.current.isCurrent(ticket) || saving) return;
    setSaving(true);
    try {
      const payload = await preparePrivateEvidenceUpload(file);
      if (!fence.current.isCurrent(ticket)) return;
      await api.createEvidence(observationId, payload);
      if (fence.current.isCurrent(ticket)) onCreated?.();
    } catch (err) {
      if (fence.current.isCurrent(ticket)) {
        setError(err?.message || 'No se pudo adjuntar la evidencia.');
      }
    } finally {
      if (fence.current.isCurrent(ticket)) setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Adjuntar evidencia"
      footer={<>
        <button type="button" className="ghost-action" onClick={onClose} disabled={saving}>Cancelar</button>
        <button type="submit" form="evidence-form" className="primary-action" disabled={saving || dataMode !== 'live' || !file}>
          {saving ? 'Subiendo…' : 'Adjuntar archivo'}
        </button>
      </>}
    >
      <form id="evidence-form" onSubmit={handleSubmit} style={{ display: 'grid', gap: 16 }}>
        {error && <div className="auth-error" role="alert"><span>{error}</span></div>}
        <label className="form-field">
          <span>Archivo real *</span>
          <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf"
            disabled={saving || dataMode !== 'live'}
            onChange={(e) => { setFile(e.target.files?.[0] || null); setError(''); }} required />
        </label>
        {file && <p style={{ margin: 0, fontSize: 13 }}>
          {file.name} · {(file.size / 1024).toFixed(0)} KiB
        </p>}
        <p style={{ fontSize: 13, color: '#64748b', margin: 0 }}>
          Fotos JPEG, PNG o WebP (se convierten a JPEG de hasta 512 KiB sin metadatos originales)
          y PDF de hasta 2 MiB. Los PDF conservan su contenido y metadatos.
          Los archivos se guardan en la base privada de la empresa; no se envían a servicios externos.
        </p>
        {dataMode !== 'live' && <p role="status" style={{ color: '#9a3412', margin: 0 }}>
          Modo demo: conectá el backend para guardar archivos.
        </p>}
      </form>
    </Modal>
  );
}
