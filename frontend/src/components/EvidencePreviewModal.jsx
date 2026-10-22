import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal.jsx';
import { useSession } from '../context/SessionContext.jsx';
import { sessionScope } from '../services/offlineSyncModel.js';
import {
  isScoutingPreviewable, parseScoutingPrivateEvidence
} from '../services/scoutingPrivateEvidenceClient.js';

// A browser Object URL is private only while its authenticated owner is
// current. Invalidate BEFORE allowing an old async request to render anything.
export function EvidencePreviewModal({ isOpen, evidence, runId, api, onClose }) {
  const { session, dataMode, entitlements } = useSession();
  const scope = dataMode === 'live' ? sessionScope(session) : null;
  const identity = scope && isOpen && evidence?.id && runId
    ? [scope, runId, session?.membership?.roleCode || '',
      [...(entitlements || [])].sort().join(','), evidence.id,
      evidence.mime_type, evidence.original_name, evidence.size_bytes].join(':') : null;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const requestSequence = useRef(0);
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState({ key: null, phase: 'idle', url: null, error: '' });

  useEffect(() => {
    const sequence = ++requestSequence.current;
    let revoked = false;
    let objectUrl = null;
    const valid = () => !revoked && requestSequence.current === sequence &&
      identityRef.current === identity && navigator.onLine !== false &&
      document.visibilityState !== 'hidden';
    const revoke = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    };
    if (!identity) {
      setSnapshot({ key: null, phase: 'idle', url: null, error: '' });
      return undefined;
    }
    if (!isScoutingPreviewable(evidence)) {
      setSnapshot({ key: identity, phase: 'error', url: null,
        error: 'Este tipo de archivo se puede descargar, pero no previsualizar.' });
      return undefined;
    }
    const interrupt = () => {
      if (revoked) return;
      revoked = true;
      requestSequence.current += 1;
      revoke();
      setSnapshot({ key: identity, phase: 'error', url: null,
        error: 'La vista previa privada se interrumpió. Volvé a cargar con tu sesión activa.' });
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') interrupt();
    };
    window.addEventListener('offline', interrupt);
    window.addEventListener('pagehide', interrupt);
    document.addEventListener('visibilitychange', onVisibility);
    setSnapshot({ key: identity, phase: 'loading', url: null, error: '' });
    const load = async () => {
      try {
        if (navigator.onLine === false) throw new Error('Sin conexión para cargar esta foto.');
        const response = await api.getEvidenceContent(evidence.id);
        if (!valid()) return;
        const { blob } = parseScoutingPrivateEvidence(response, evidence);
        if (!valid()) return;
        const url = URL.createObjectURL(blob);
        if (!valid()) {
          URL.revokeObjectURL(url);
          return;
        }
        objectUrl = url;
        setSnapshot({ key: identity, phase: 'ready', url, error: '' });
      } catch (error) {
        if (valid()) setSnapshot({ key: identity, phase: 'error', url: null,
          error: error?.message || 'No se pudo cargar la fotografía privada.' });
      }
    };
    void load();
    return () => {
      revoked = true;
      requestSequence.current += 1;
      revoke();
      window.removeEventListener('offline', interrupt);
      window.removeEventListener('pagehide', interrupt);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [identity, api, revision]);

  const visible = identity && snapshot.key === identity ? snapshot :
    { phase: 'idle', url: null, error: '' };
  const label = identity ? evidence?.original_name || 'Vista previa' : 'Vista previa privada';
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={label}
      footer={<button type="button" className="ghost-action" onClick={onClose}>Cerrar</button>} wide>
      <div style={{ minHeight: 120, display: 'grid', placeItems: 'center', gap: 12 }}>
        {!identity && <p role="alert">Esta fotografía no está disponible para la sesión actual.</p>}
        {visible.phase === 'loading' && <p role="status">Cargando archivo privado…</p>}
        {visible.error && <p role="alert" style={{ color: '#b91c1c' }}>{visible.error}</p>}
        {visible.phase === 'error' && identity && <button className="ghost-action" type="button"
          onClick={() => setRevision(value => value + 1)}
          disabled={navigator.onLine === false || document.visibilityState === 'hidden'}>
          Volver a cargar
        </button>}
        {visible.phase === 'ready' && visible.url &&
          <img src={visible.url} alt={evidence?.original_name || 'Fotografía de monitoreo'}
            style={{ display: 'block', maxHeight: '65vh', maxWidth: '100%',
              width: 'auto', objectFit: 'contain', borderRadius: 8 }} />}
        <p style={{ color: '#64748b', fontSize: 12, margin: 0 }}>
          Fotografía privada de la sesión actual. No se publica como URL externa.
        </p>
      </div>
    </Modal>
  );
}
