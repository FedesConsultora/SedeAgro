import { useState } from 'react';
import { useSession } from '../context/SessionContext.jsx';
import { Modal } from './Modal.jsx';

const ACCEPTED = {
  'image/jpeg': 'photo',
  'image/png': 'photo',
  'image/webp': 'photo',
  'application/pdf': 'document'
};
const MAX_BYTES = 2 * 1024 * 1024;

async function readBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('No se pudo leer el archivo.'));
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.readAsDataURL(file);
  });
}

export function EvidenceUploadModal({ isOpen, onClose, onCreated, observationId }) {
  const { api, dataMode } = useSession();
  const [file, setFile] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');
    if (dataMode !== 'live') {
      setError('La carga de evidencias requiere conectar el backend; el modo demo no guarda archivos.');
      return;
    }
    if (!file || !Object.hasOwn(ACCEPTED, file.type)) {
      setError('Seleccioná una foto JPEG/PNG/WebP o un documento PDF.');
      return;
    }
    if (!file.size || file.size > MAX_BYTES) {
      setError('El archivo debe tener contenido y pesar como máximo 2 MiB.');
      return;
    }
    setSaving(true);
    try {
      const content_base64 = await readBase64(file);
      await api.createEvidence(observationId, {
        kind: ACCEPTED[file.type],
        mime_type: file.type,
        original_name: file.name,
        content_base64
      });
      onCreated?.();
    } catch (err) {
      setError(err?.message || 'No se pudo adjuntar la evidencia.');
    } finally {
      setSaving(false);
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
          Fotos JPEG, PNG o WebP y documentos PDF. Hasta 2 MiB por archivo.
          El archivo se guarda en la base privada de la empresa; no se envía a servicios externos.
        </p>
        {dataMode !== 'live' && <p role="status" style={{ color: '#9a3412', margin: 0 }}>
          Modo demo: conectá el backend para guardar archivos.
        </p>}
      </form>
    </Modal>
  );
}
