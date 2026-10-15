import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowRight, Camera, CheckCircle2, RefreshCw } from 'lucide-react';
import { useSession } from '../context/SessionContext.jsx';
import { canNavigateView } from '../services/navigationAccess.js';
import { sessionScope, QUEUE_EVENT } from '../services/offlineSyncModel.js';
import { offlineQueue } from '../services/offlineQueue.js';
import { buildRunEvidenceProvenance } from '../services/runEvidenceProvenance.js';
import { EvidenceIntegrityChecks } from './EvidenceIntegrityChecks.jsx';
import { advanceEvidencePage, previousEvidencePage, isInvalidEvidenceCursor } from '../services/evidencePageNavigation.js';
import './run-evidence-provenance.css';

const STATUS = {
  present: { title: 'Fotografía encontrada en PostgreSQL', detail: 'Metadatos e identidad del envío coinciden; bytes privados presentes.' },
  metadata_only: { title: 'Solo metadatos en PostgreSQL', detail: 'El archivo no tiene un blob privado disponible. No descartes tu copia local.' },
  mismatch: { title: 'Datos del envío no coinciden', detail: 'La clave existe, pero no coinciden los metadatos exactos. Requiere revisión.' },
  outside_window: { title: 'Fuera de la ventana verificable', detail: 'La página consultada no permite confirmar esta foto. No es prueba de fallo.' },
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
  const [navigation, setNavigation] = useState({ key: null, cursors: [] });
  const pageCursors = navigation.key === key ? navigation.cursors : [];
  const cursor = pageCursors.length ? pageCursors[pageCursors.length - 1] : null;
  const pageKey = key ? `${key}|${cursor || 'latest'}` : null;
  const pageNumber = pageCursors.length + 1;
  const [snapshot, setSnapshot] = useState({ key: null, phase: 'loading', result: null, error: '' });

  useEffect(() => {
    const sequence = ++requestSeq.current;
    const controller = new AbortController();
    if (!pageKey) {
      setSnapshot({ key: null, phase: 'unavailable', result: null, error: '' });
      return undefined;
    }
    const disconnected = navigator.onLine === false;
    setSnapshot({ key: pageKey, phase: disconnected ? 'offline' : 'loading', result: null, error: '' });
    if (!disconnected) {
      // Read metadata and the active account's encrypted browser drafts.
      // No binary body is retrieved from the server.
      void Promise.all([
        api.getRunEvidencePage(runId, cursor, { signal: controller.signal }),
        offlineQueue.list(session)
      ]).then(([response, rows]) => {
        const result = buildRunEvidenceProvenance(response, rows, session, runId,
          { paginated: true, expectedLimit: 10 });
        if (!controller.signal.aborted && requestSeq.current === sequence &&
            contextRef.current === key && navigator.onLine !== false) {
          setSnapshot({ key: pageKey, phase: 'ready', result, error: '' });
        }
      }).catch(error => {
        if (!controller.signal.aborted && requestSeq.current === sequence &&
            contextRef.current === key) {
          setSnapshot({
            key: pageKey, phase: cursor && isInvalidEvidenceCursor(error) ? 'invalid-cursor' : 'error',
            result: null,
            error: error?.message || 'No se pudo verificar la disponibilidad de las evidencias.'
          });
        }
      });
    }
    const update = () => setRevision(value => value + 1);
    const online = () => {
      // Do not continue a cursor chain that may have become stale offline.
      setNavigation({ key, cursors: [] });
      update();
    };
    const offline = () => {
      controller.abort();
      requestSeq.current += 1;
      if (contextRef.current === key) {
        setSnapshot({ key: pageKey, phase: 'offline', result: null, error: '' });
      }
    };
    const visibility = () => {
      if (document.visibilityState === 'visible') update();
    };
    window.addEventListener(QUEUE_EVENT, update);
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      requestSeq.current += 1;
      controller.abort();
      window.removeEventListener(QUEUE_EVENT, update);
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [api, session, key, runId, cursor, pageKey, revision]);

  if (!key || !allowed) return null;
  const visible = snapshot.key === pageKey ? snapshot :
    { key: pageKey, phase: 'loading', result: null, error: '' };
  const result = visible.phase === 'ready' ? visible.result : null;
  const refreshFirst = () => {
    setNavigation({ key, cursors: [] });
    setRevision(value => value + 1);
  };
  const nextPage = () => {
    if (result?.hasMore && result?.nextCursor) {
      try {
        setNavigation({ key, cursors: advanceEvidencePage(pageCursors, result.nextCursor) });
      } catch {
        setSnapshot({ key: pageKey, phase: 'error', result: null,
          error: 'La paginación devolvió una página repetida. Reiniciá el historial.' });
      }
    }
  };
  const previousPage = () => {
    if (pageCursors.length) {
      setNavigation({ key, cursors: previousEvidencePage(pageCursors) });
    }
  };

  return (
    <section className="run-evidence" aria-label="Verificación de evidencias de la recorrida">
      <div className="run-evidence__header">
        <div>
          <span className="run-evidence__eyebrow">Evidencias · almacenamiento privado</span>
          <h3>Verificación de fotografías y archivos</h3>
        </div>
        <button type="button" className="ghost-action" disabled={visible.phase === 'loading'}
          onClick={refreshFirst}>
          <RefreshCw size={14} aria-hidden="true" /> Verificar de nuevo
        </button>
      </div>
      <p className="run-evidence__hint">
        Consulta 10 evidencias por página, incluidas las antiguas cuando navegás
        hacia atrás en el historial. Comprueba la presencia de bytes privados sin descargarlos.
        Las fotos pendientes cifradas se comparan solo con las de tu cuenta y empresa.
      </p>
      {visible.phase === 'loading' &&
        <p role="status" className="run-evidence__hint">Consultando el almacenamiento de evidencias…</p>}
      {visible.phase === 'offline' &&
        <p role="status" className="run-evidence__hint">
          Sin conexión. No se puede afirmar qué archivos están actualmente disponibles.
        </p>}
      {(visible.phase === 'error' || visible.phase === 'invalid-cursor') &&
        <div className="run-evidence__error" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <div>
            <p>{visible.phase === 'invalid-cursor'
              ? 'Este cursor dejó de ser válido. Volvé a la primera página para consultar una lista actual.'
              : visible.error} No se puede afirmar que no existan archivos.</p>
            <div className="run-evidence__retry-actions">
              {visible.phase === 'error' && <button className="ghost-action" type="button"
                onClick={() => setRevision(value => value + 1)}
                disabled={navigator.onLine === false}>Reintentar esta página</button>}
              <button className="ghost-action" type="button"
                onClick={refreshFirst} disabled={navigator.onLine === false}>
                Reiniciar historial
              </button>
            </div>
          </div>
        </div>}
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
          Hay más evidencias en páginas anteriores. Que una foto no figure aquí no demuestra
          que su carga haya fallado.
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
          <h4 className="run-evidence__subheading">Archivos registrados · página {pageNumber}</h4>
          <p className="run-evidence__hint">
            Para verificar el SHA-256 seleccioná un archivo. La comprobación se ejecuta
            individualmente en el servidor sin descargar su contenido a este dispositivo.
          </p>
          <EvidenceIntegrityChecks key={pageKey}
            scopeKey={key} items={result.items.slice(0, 10)} />
        </>}
        <nav className="run-evidence__pagination" aria-label="Páginas de evidencias">
          <span>Página {pageNumber} · {result.items.length} archivos en esta página</span>
          <div className="run-evidence__pagination-actions">
            <button type="button" className="ghost-action" onClick={previousPage}
              disabled={!pageCursors.length}>Página anterior</button>
            <button type="button" className="ghost-action" onClick={nextPage}
              disabled={!result.hasMore || !result.nextCursor}>Archivos anteriores</button>
          </div>
        </nav>
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
