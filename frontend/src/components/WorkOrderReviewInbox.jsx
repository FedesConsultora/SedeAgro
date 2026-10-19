import { useEffect, useRef, useState } from 'react';
import { useSession } from '../context/SessionContext.jsx';
import { isCoordinationReviewer, REVIEW_QUEUE_STATES,
  REVIEW_QUEUE_PAGE_FILTERS, filterReviewQueuePage,
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
  const [filter, setFilter] = useState('all');
  const scope = [tenantId, userId, role, revision].join(':');
  const cursor = cursors[page] ?? null;
  const [reload, setReload] = useState(0);
  const headingRef = useRef(null);
  const errorActionRef = useRef(null);
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

  useEffect(() => {
    // The page controls unmount on an error. Preserve the keyboard user's
    // position by focusing the recovery action instead of dropping to body.
    if (error && focusOnNavigation.current) {
      focusOnNavigation.current = false;
      errorActionRef.current?.focus();
    }
  }, [error]);

  if (!available) return null;
  const items = shown?.items ?? [];
  // Only the fifty currently authorized results: NEVER an unbounded search.
  const visibleItems = filterReviewQueuePage(items, filter);
  const changePage = direction => {
    if (loading || error || !shown) return;
    if (direction < 0 && page > 0) {
      focusOnNavigation.current = true;
      setFilter('all');
      setPage(value => value - 1);
    } else if (direction > 0 && shown.hasMore && shown.nextCursor) {
      focusOnNavigation.current = true;
      setFilter('all');
      setCursors(previous => [...previous.slice(0, page + 1), shown.nextCursor]);
      setPage(page + 1);
    }
  };
  const refresh = () => {
    focusOnNavigation.current = false;
    setFilter('all');
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
        ? <button type="button" ref={errorActionRef} className="ghost-action"
          onClick={refresh}>Iniciar nueva consulta</button>
        : <button type="button" ref={errorActionRef} className="ghost-action"
          onClick={() => setReload(value => value + 1)}>Reintentar</button>}
    </div>}
    {!loading && !error && shown && <>
      <p role="status" aria-live="polite" className="orders-workspace__review-announcement">
        Página {page + 1}. {items.length} órdenes en esta página.
      </p>
      <fieldset className="orders-workspace__review-filters">
        <legend>Filtrar solo esta página</legend>
        <div className="orders-workspace__review-filter-options">
          {Object.entries(REVIEW_QUEUE_PAGE_FILTERS).map(([key, option]) =>
            <button key={key} type="button" className={`ghost-action ${filter === key
              ? 'orders-workspace__review-filter--active' : ''}`}
              aria-pressed={filter === key} onClick={() => setFilter(key)}>
              {option.label}
            </button>)}
        </div>
      </fieldset>
      <p role="status" aria-live="polite" className="orders-workspace__review-announcement">
        {visibleItems.length} de {items.length} órdenes visibles en esta página.
        El filtro no busca en otras páginas.
      </p>
      {items.length === 0 && <p role="status">No hay órdenes en curso en esta página.</p>}
      {items.length > 0 && visibleItems.length === 0 && <p role="status">
        Sin coincidencias en esta página. Probá otro filtro o navegá a otra página disponible.
      </p>}
      <div className="orders-workspace__review-items">
        {visibleItems.map(item => <article key={item.id} className="orders-workspace__review-item">
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
