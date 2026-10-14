import { useEffect, useState } from 'react';
import { Modal } from './Modal.jsx';

const PREVIEWABLE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function EvidencePreviewModal({ isOpen, evidence, api, onClose }) {
  const [previewUrl, setPreviewUrl] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen || !evidence) return;
    let cancelled = false;
    let url = null;
    setPreviewUrl(null);
    setError('');
    if (!PREVIEWABLE_MIME_TYPES.has(evidence.mime_type)) {
      setError('Este tipo de documento se puede descargar, pero no previsualizar.');
      return undefined;
    }
    setLoading(true);
    async function load() {
      try {
        const response = await api.getEvidenceContent(evidence.id);
        if (!PREVIEWABLE_MIME_TYPES.has(response.data.mime_type)) {
          throw new Error('El tipo de archivo no permite vista previa.');
        }
        const binary = atob(response.data.content_base64);
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        url = URL.createObjectURL(new Blob([bytes], { type: response.data.mime_type }));
        if (cancelled) URL.revokeObjectURL(url);
        else setPreviewUrl(url);
      } catch (err) {
        if (!cancelled) setError(err?.message || 'No se pudo cargar la vista previa.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [isOpen, evidence, api]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={evidence?.original_name || 'Vista previa'}
      footer={<button type="button" className="ghost-action" onClick={onClose}>Cerrar</button>} wide>
      <div style={{ minHeight: 120, display: 'grid', placeItems: 'center', gap: 12 }}>
        {loading && <p role="status">Cargando archivo privado…</p>}
        {error && <p role="alert" style={{ color: '#b91c1c' }}>{error}</p>}
        {previewUrl && <img src={previewUrl} alt={evidence?.original_name || 'Fotografía de monitoreo'}
          style={{ display: 'block', maxHeight: '65vh', maxWidth: '100%', width: 'auto', objectFit: 'contain', borderRadius: 8 }} />}
        <p style={{ color: '#64748b', fontSize: 12, margin: 0 }}>
          Imagen privada. Se descarga con tu sesión y no se publica como URL externa.
        </p>
      </div>
    </Modal>
  );
}
