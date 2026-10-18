import { useEffect, useRef, useState } from 'react';
import { useSession } from '../context/SessionContext.jsx';
import { isCoordinationReviewer, REVIEW_QUEUE_STATES,
  reviewQueueUrl, reviewQueueFailure, reviewQueueRequestKey,
  validateReviewQueue } from '../services/workOrderReviewQueue.js';

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
  const headingRef = useRef(null);
  const focusOnNavigation = useRef(false);
  const requestKey = reviewQueueRequestKey(page, cursor, reload);
  const [requestState, setRequestState] = useState(null);
  // A response can render ONLY against its own page/cursor/reload key.
  // This avoids a frame showing the previous page during effect scheduling.
  const current = requestState?.key === requestKey ? requestState : null;
  const loading = !current || current.phase === 'loading';
  const error = current?.phase === 'error' ? current.failure : null;
  const shown = current?.phase === 'ready' ? current.result : null;

  useEffect(() => {
    if (!available) return undefined;
    let active = true;
    const controller = new AbortController();
    setRequestState({ key: requestKey, phase: 'loading' });
    api.request(reviewQueueUrl(cursor), { silent: true, signal: controller.signal })
      .then(result => {
        const validated = validateReviewQueue(result);
        if (active) setRequestState({ key: requestKey, phase: 'ready', result: validated });
      })
      .catch(err => {
        if (active) setRequestState({ key: requestKey, phase: 'error',
          failure: reviewQueueFailure(err, cursor !== null) });
      });
    return () => { active = false; controller.abort(); };
  }, [api, available, cursor, requestKey, tenantId, userId, scope]);

  useEffect(() => {
    if (shown && focusOnNavigation.current) {
      focusOnNavigation.current = false;
      headingRef.current?.focus();
    }
  }, [shown]);

  if (!available) return null;
  const items = shown?.items ?? [];
  const changePage = direction => {
    if (loading || error || !shown) return;
    if (direction < 0 && page > 0) {
      focusOnNavigation.current = true;
      setPage(value => value - 1);
    } else if (direction > 0 && shown.hasMore && shown.nextCursor) {
      focusOnNavigation.current = true;
      setCursors(previous => [...previous.slice(0, page + 1), shown.nextCursor]);
      setPage(page + 1);
    }
  };
  const refresh = () => {
    focusOnNavigation.current = false;
    setPage(0);
    setCursors([null]);
    setReload(value => value + 1);
  };
  return <section className="orders-workspace__review-inbox" aria-labelledby="review-inbox-title"
    aria-busy={loading}>
    <div className="orders-workspace__review-heading">
      <div>
        <h2 id="review-inbox-title" ref={headingRef} tabIndex={-1}>Pendientes de coordinación</h2>
        <p>Orientación según datos actuales del servidor. La aprobación exige revisión humana,
          controles de integridad y validación nuevamente al guardar.</p>
      </div>
      <button type="button" className="ghost-action" disabled={loading}
        onClick={refresh}>Actualizar pendientes</button>
    </div>
    {loading && <p role="status">Consultando pendientes autorizados…</p>}
    {error && <div role="alert" className="orders-workspace__error">
      <span>{error.message}</span>
      {error.expired
        ? <button type="button" className="ghost-action"
          onClick={refresh}>Iniciar nueva consulta</button>
        : <button type="button" className="ghost-action"
          onClick={() => setReload(value => value + 1)}>Reintentar</button>}
    </div>}
    {!loading && !error && shown && <>
      <p role="status" aria-live="polite" className="orders-workspace__review-announcement">
        Página {page + 1}. {items.length} órdenes en esta página.
      </p>
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
        <button type="button" className="ghost-action" disabled={page === 0 || loading}
          aria-label="Página anterior de pendientes"
          onClick={() => changePage(-1)}>Anterior</button>
        <button type="button" className="ghost-action" disabled={!shown?.hasMore || loading}
          aria-label="Página siguiente de pendientes"
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
