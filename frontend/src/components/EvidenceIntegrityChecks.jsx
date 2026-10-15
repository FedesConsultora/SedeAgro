import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ShieldCheck } from 'lucide-react';
import { useSession } from '../context/SessionContext.jsx';
import { sessionScope } from '../services/offlineSyncModel.js';
import { EVIDENCE_INTEGRITY_STATUS, parseEvidenceIntegrity } from '../services/evidenceIntegrityPresentation.js';

// This UI NEVER starts a scan. Each user action verifies exactly one visible
// asset. The app does not retain a verification across tenant/user/run changes,
// network loss or a refresh of the authoritative evidence list.
export function EvidenceIntegrityChecks({ items, scopeKey }) {
  const { api, session, dataMode } = useSession();
  const ownScope = dataMode === 'live' ? sessionScope(session) : null;
  const allowed = Boolean(ownScope && scopeKey.startsWith(ownScope + ':'));
  const serial = useRef(0);
  const [busyId, setBusyId] = useState(null);
  const [results, setResults] = useState({});

  useEffect(() => {
    serial.current += 1;
    setBusyId(null);
    setResults({});
    const onOffline = () => {
      serial.current += 1;
      setBusyId(null);
      setResults({});
    };
    window.addEventListener('offline', onOffline);
    return () => {
      serial.current += 1;
      window.removeEventListener('offline', onOffline);
    };
  }, [scopeKey, ownScope, api]);

  const check = async (id) => {
    if (!allowed || busyId || navigator.onLine === false ||
        !items.some(item => item.id === id)) return;
    const requestId = ++serial.current;
    setBusyId(id);
    setResults(previous => ({ ...previous, [id]: { phase: 'loading' } }));
    try {
      const response = await api.getEvidenceIntegrity(id);
      const status = parseEvidenceIntegrity(response, id);
      if (serial.current === requestId && navigator.onLine !== false) {
        setResults(previous => ({
          ...previous, [id]: { phase: 'ready', status }
        }));
      }
    } catch (error) {
      if (serial.current === requestId) {
        setResults(previous => ({ ...previous, [id]: {
          phase: 'error',
          error: error?.message || 'No se pudo verificar este archivo.'
        } }));
      }
    } finally {
      if (serial.current === requestId) setBusyId(null);
    }
  };

  if (!allowed) return null;
  return (
    <ol className="run-evidence__list" aria-label="Evidencias con verificación individual">
      {items.map(item => {
        const state = results[item.id];
        const detail = state?.phase === 'ready' ? EVIDENCE_INTEGRITY_STATUS[state.status] : null;
        return (
          <li className="run-evidence__item" key={item.id}>
            <div className="run-evidence__server-row">
              <span>{item.kind === 'photo' ? 'Fotografía' : 'Documento'} {item.id.slice(0,8)}…</span>
              <strong className={item.bytesAvailable ? 'run-evidence__present' : 'run-evidence__missing'}>
                {item.bytesAvailable ? 'Bytes presentes · integridad sin verificar' : 'Solo metadatos'}
              </strong>
            </div>
            <button type="button" className="ghost-action run-evidence__check"
              onClick={() => void check(item.id)}
              disabled={Boolean(busyId) || navigator.onLine === false}>
              <ShieldCheck size={14} aria-hidden="true" />
              {busyId === item.id ? 'Comprobando SHA-256…' : 'Verificar SHA-256'}
            </button>
            {state?.phase === 'loading' && <p role="status" className="run-evidence__hint">
              Comprobando un archivo privado en el servidor…
            </p>}
            {state?.phase === 'error' && <p role="alert" className="run-evidence__error">
              <AlertTriangle size={15} aria-hidden="true" />
              {state.error} No se puede asegurar su integridad.
            </p>}
            {detail && <div className="run-evidence__integrity" role="status">
              {state.status === 'verified'
                ? <CheckCircle2 size={16} color="#23754c" aria-hidden="true" />
                : <AlertTriangle size={16} color="#a56624" aria-hidden="true" />}
              <div>
                <strong>{detail.label}</strong>
                <p className="run-evidence__hint">{detail.detail}</p>
              </div>
            </div>}
          </li>
        );
      })}
    </ol>
  );
}
