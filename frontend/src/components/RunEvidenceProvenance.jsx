import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowRight, Camera, CheckCircle2, RefreshCw } from 'lucide-react';
import { useSession } from '../context/SessionContext.jsx';
import { canNavigateView } from '../services/navigationAccess.js';
import { sessionScope, QUEUE_EVENT } from '../services/offlineSyncModel.js';
import { offlineQueue } from '../services/offlineQueue.js';
import { buildRunEvidenceProvenance } from '../services/runEvidenceProvenance.js';
import './run-evidence-provenance.css';

const STATUS = {
  present: { title: 'Fotografía encontrada en PostgreSQL', detail: 'Metadatos e identidad del envío coinciden; bytes privados presentes.' },
  metadata_only: { title: 'Solo metadatos en PostgreSQL', detail: 'El archivo no tiene un blob privado disponible. No descartes tu copia local.' },
  mismatch: { title: 'Datos del envío no coinciden', detail: 'La clave existe, pero no coinciden los metadatos exactos. Requiere revisión.' },
  outside_window: { title: 'Fuera de la ventana verificable', detail: 'Los 100 registros recientes no permiten confirmar esta foto. No es prueba de fallo.' },
  not_listed: { title: 'No figura en la consulta', detail: 'No es una confirmación de subida ni una prueba definitiva de que haya fallado.' }
};
const shortId = id => typeof id === 'string' ? id.slice(0, 8) + '…' : 'Sin ID';
const formatDate = value => value && Number.isFinite(Date.parse(value))
  ? new Date(value).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })
  : 'Sin fecha';

export function RunEvidenceProvenance({ runId, onOpenSync }) {
  const { api, dataMode, session, entitlements } = useSession();
  const access = {
    role: session?.membership?.roleCode || '',
    entitlements, platformAdmin: Boolean(session?.user?.isPlatformAdmin)
  };
  const allowed = dataMode === 'live' && canNavigateView('scouting', access);
  const scope = allowed ? sessionScope(session) : null;
  const key = scope ? [scope, runId, access.role, [...(entitlements || [])].sort().join(',')].join(':') : null;
  const contextRef = useRef(key);
  contextRef.current = key;
  const requestSeq = useRef(0);
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState({ key: null, phase: 'loading', result: null, error: '' });

  useEffect(() => {
    const sequence = ++requestSeq.current;
    if (!key) {
      setSnapshot({ key: null, phase: 'unavailable', result: null, error: '' });
      return undefined;
    }
    const disconnected = navigator.onLine === false;
    setSnapshot({ key, phase: disconnected ? 'offline' : 'loading', result: null, error: '' });
    if (!disconnected) {
      // Read metadata and the active account's encrypted browser drafts.
      // No binary body is retrieved from the server.
      void Promise.all([
        api.getRunEvidenceStatus(runId),
        offlineQueue.list(session)
      ]).then(([response, rows]) => {
        const result = buildRunEvidenceProvenance(response, rows, session, runId);
        if (requestSeq.current === sequence && contextRef.current === key &&
            navigator.onLine !== false) {
          setSnapshot({ key, phase: 'ready', result, error: '' });
        }
      }).catch(error => {
        if (requestSeq.current === sequence && contextRef.current === key) {
          setSnapshot({
            key, phase: 'error', result: null,
            error: error?.message || 'No se pudo verificar la disponibilidad de las evidencias.'
          });
        }
      });
    }
    const update = () => setRevision(value => value + 1);
    const offline = () => {
      requestSeq.current += 1;
      if (contextRef.current === key) {
        setSnapshot({ key, phase: 'offline', result: null, error: '' });
      }
    };
    const visibility = () => {
      if (document.visibilityState === 'visible') update();
    };
    window.addEventListener(QUEUE_EVENT, update);
    window.addEventListener('online', update);
    window.addEventListener('offline', offline);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      requestSeq.current += 1;
      window.removeEventListener(QUEUE_EVENT, update);
      window.removeEventListener('online', update);
      window.removeEventListener('offline', offline);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [api, session, key, runId, revision]);

  if (!key || !allowed) return null;
  const visible = snapshot.key === key ? snapshot :
    { key, phase: 'loading', result: null, error: '' };
  const result = visible.phase === 'ready' ? visible.result : null;

  return (
    <section className="run-evidence" aria-label="Verificación de evidencias de la recorrida">
      <div className="run-evidence__header">
        <div>
          <span className="run-evidence__eyebrow">Evidencias · almacenamiento privado</span>
          <h3>Verificación de fotografías y archivos</h3>
        </div>
        <button type="button" className="ghost-action" disabled={visible.phase === 'loading'}
          onClick={() => setRevision(value => value + 1)}>
          <RefreshCw size={14} aria-hidden="true" /> Verificar de nuevo
        </button>
      </div>
      <p className="run-evidence__hint">
        Consulta metadatos de hasta 100 evidencias recientes de esta recorrida y
        comprueba que existan sus bytes privados. No descarga ni muestra archivos.
        Las fotos pendientes cifradas se comparan solo con las de tu cuenta y empresa.
      </p>
      {visible.phase === 'loading' &&
        <p role="status" className="run-evidence__hint">Consultando el almacenamiento de evidencias…</p>}
      {visible.phase === 'offline' &&
        <p role="status" className="run-evidence__hint">
          Sin conexión. No se puede afirmar qué archivos están actualmente disponibles.
        </p>}
      {visible.phase === 'error' &&
        <p role="alert" className="run-evidence__error">
          <AlertTriangle size={16} aria-hidden="true" /> {visible.error}
          No se puede afirmar que no existan archivos.
        </p>}
      {result && <>
        <div className="run-evidence__counts" role="status">
          <span><Camera size={15} aria-hidden="true" /> {result.photosWithBytes} fotografías con bytes presentes</span>
          <span><AlertTriangle size={15} aria-hidden="true" /> {result.missingBytes} evidencias sin blob privado</span>
          <span>{result.localPhotos.length} fotografías aún en este dispositivo</span>
        </div>
        {result.items.length === 0 &&
          <p className="run-evidence__hint" role="status">
            No hay metadatos de evidencias en la consulta actual. No demuestra que nunca se hayan adjuntado.
          </p>}
        {result.hasMore && <p className="run-evidence__warning" role="status">
          Hay más de 100 evidencias. Las anteriores quedan fuera de esta consulta, por lo que
          ningún resultado ausente se interpreta como un fallo.
        </p>}
        {result.localPhotos.length > 0 && <>
          <h4 className="run-evidence__subheading">Fotografías locales por comprobar</h4>
          <ol className="run-evidence__list">
            {result.localPhotos.map(photo => (
              <li className="run-evidence__item" key={photo.id}>
                <div className="run-evidence__item-heading">
                  {photo.status === 'present'
                    ? <CheckCircle2 size={16} color="#23754c" aria-hidden="true" />
                    : <AlertTriangle size={16} color="#a56624" aria-hidden="true" />}
                  <strong>{STATUS[photo.status].title}</strong>
                  <small>{formatDate(photo.createdAt)}</small>
                </div>
                <p className="run-evidence__hint">{STATUS[photo.status].detail}</p>
                {photo.evidenceId &&
                  <span className="run-evidence__hint">Evidencia {shortId(photo.evidenceId)}</span>}
              </li>
            ))}
          </ol>
        </>}
        {result.items.length > 0 && <>
          <h4 className="run-evidence__subheading">Últimos archivos registrados en el servidor</h4>
          <ol className="run-evidence__list">
            {result.items.slice(0, 10).map(asset => (
              <li className="run-evidence__server-row" key={asset.id}>
                <span>{asset.kind === 'photo' ? 'Fotografía' : 'Documento'} {shortId(asset.id)}</span>
                <strong className={asset.bytesAvailable ? 'run-evidence__present' : 'run-evidence__missing'}>
                  {asset.bytesAvailable ? 'Bytes presentes' : 'Solo metadatos'}
                </strong>
              </li>
            ))}
          </ol>
          {result.items.length > 10 && <p className="run-evidence__hint">
            Se resumen 10 de {result.items.length} archivos registrados en esta respuesta.
          </p>}
        </>}
      </>}
      <div className="run-evidence__footer">
        <p className="run-evidence__hint">
          Presencia de bytes no implica validación criptográfica de contenido. Esta pantalla
          no elimina capturas ni sustituye la confirmación de subida; para recuperarlas,
          revisá Sincronizaciones.
        </p>
        <button className="ghost-action" type="button" onClick={() => onOpenSync?.()}>
          Ir a Sincronizaciones <ArrowRight size={14} aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}
