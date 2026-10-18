import { useEffect, useState } from 'react';
import { useSession } from '../context/SessionContext.jsx';
import { isCoordinationReviewer, REVIEW_QUEUE_STATES,
  reviewQueueUrl, validateReviewQueue } from '../services/workOrderReviewQueue.js';

// This is a navigational inbox, never an approve/close action. Opening the
// order fetches a fresh authorized detail; the server owns every transition.
function WorkOrderReviewInboxSession({ onOpenOrder, revision }) {
  const { api, dataMode, session } = useSession();
  const role = session?.membership?.roleCode;
  const userId = session?.user?.id;
  const tenantId = session?.membership?.tenantId || session?.tenant?.id;
  const available = isCoordinationReviewer(role, dataMode, session?.authenticated);
  const [cursors, setCursors] = useState([null]);
  const [page, setPage] = useState(0);
  const scope = [tenantId, userId, role, revision].join(':');
  const cursor = cursors[page] ?? null;
  const [reload, setReload] = useState(0);
  const [response, setResponse] = useState(null);
  const [loadedScope, setLoadedScope] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!available) {
      setResponse(null);
      setError('');
      return undefined;
    }
    let active = true;
    setResponse(null);
    setLoading(true);
    setError('');
    setLoadedScope('');
    api.request(reviewQueueUrl(cursor), { silent: true })
      .then(result => {
        const validated = validateReviewQueue(result);
        if (active) { setResponse(validated); setLoadedScope(scope); }
      })
      .catch(err => {
        if (active) setError(err?.message || 'No se pudo consultar la bandeja de revisión.');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, available, cursor, page, reload, revision, tenantId, userId, scope]);

  if (!available) return null;
  const shown = loadedScope === scope ? response : null;
  const items = shown?.items ?? [];
  const changePage = direction => {
    if (direction < 0) {
      setPage(value => Math.max(0, value - 1));
    } else if (shown?.hasMore && shown.nextCursor) {
      setCursors(previous => [...previous.slice(0, page + 1), shown.nextCursor]);
      setPage(page + 1);
    }
  };
  const refresh = () => {
    setPage(0);
    setCursors([null]);
    setReload(value => value + 1);
  };
  return <section className="orders-workspace__review-inbox" aria-labelledby="review-inbox-title">
    <div className="orders-workspace__review-heading">
      <div>
        <h2 id="review-inbox-title">Pendientes de coordinación</h2>
        <p>Orientación según datos actuales del servidor. La aprobación exige revisión humana,
          controles de integridad y validación nuevamente al guardar.</p>
      </div>
      <button type="button" className="ghost-action" disabled={loading}
        onClick={refresh}>Actualizar pendientes</button>
    </div>
    {loading && <p role="status">Consultando pendientes autorizados…</p>}
    {error && <div role="alert" className="orders-workspace__error">
      <span>No se pudo cargar la bandeja. {error}</span>
      <button type="button" className="ghost-action"
        onClick={() => setReload(value => value + 1)}>Reintentar</button>
    </div>}
    {!loading && !error && shown && <>
      {items.length === 0 && <p role="status">No hay órdenes en curso en esta página.</p>}
      <div className="orders-workspace__review-items">
        {items.map(item => <article key={item.id} className="orders-workspace__review-item">
          <div className="orders-workspace__review-item-copy">
            <strong>{item.title}</strong>
            <span>{REVIEW_QUEUE_STATES[item.state]}</span>
            <p>{item.reason}</p>
          </div>
          <button type="button" className="ghost-action"
            onClick={() => onOpenOrder({ id: item.id, title: item.title })}>
            Abrir orden y comprobar
          </button>
        </article>)}
      </div>
      <div className="orders-workspace__review-pagination">
        <span>Página {page + 1} · hasta 50 órdenes por página</span>
        <button type="button" className="ghost-action" disabled={page === 0}
          onClick={() => changePage(-1)}>Anterior</button>
        <button type="button" className="ghost-action" disabled={!shown?.hasMore}
          onClick={() => changePage(1)}>Siguiente</button>
      </div>
    </>}
  </section>;
}

// Remount each inbox when the tenant, account or parent dataset revision
// changes: opaque cursors must NEVER be replayed for a different identity.
export function WorkOrderReviewInbox({ onOpenOrder, revision }) {
  const { session, dataMode } = useSession();
  const identity = [session?.membership?.tenantId || session?.tenant?.id || '',
    session?.user?.id || '', session?.membership?.roleCode || '', dataMode, revision].join(':');
  return <WorkOrderReviewInboxSession key={identity}
    revision={revision} onOpenOrder={onOpenOrder} />;
}
