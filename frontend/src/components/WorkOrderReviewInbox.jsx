import { useEffect, useRef, useState } from 'react';
import { useSession } from '../context/SessionContext.jsx';
import { isCoordinationReviewer, REVIEW_QUEUE_STATES,
  REVIEW_QUEUE_PAGE_FILTERS,
  REVIEW_QUEUE_WORK_TYPES, REVIEW_QUEUE_PRIORITIES, REVIEW_QUEUE_DUE_WINDOWS,
  REVIEW_QUEUE_SORT_MODES,
  reviewQueueUrl, reviewQueueFailure, reviewQueueRequestKey,
  validateReviewQueue, normalizeReviewTitleQuery } from '../services/workOrderReviewQueue.js';
import { REVIEW_VIEW_LIMIT, REVIEW_VIEWS_PATH, normalizeReviewViewName,
  reviewViewFilters, validateSavedView, validateSavedViews
} from '../services/reviewQueueSavedViews.js';
import { REVIEW_MODERATION_PATH,normalizeModerationReason,
  validateModerationInventory,validateModerationAudit,validateModerationRevoke
} from '../services/reviewQueueViewModeration.js';

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
  const [reviewState, setReviewState] = useState('all');
  const [workType, setWorkType] = useState('all');
  const [priority, setPriority] = useState('all');
  const [dueWindow, setDueWindow] = useState('all');
  const [sortMode, setSortMode] = useState('newest');
  const [draftTitle, setDraftTitle] = useState('');
  const [titleQuery, setTitleQuery] = useState('');
  const [titleError, setTitleError] = useState('');
  const [savedViews, setSavedViews] = useState([]);
  const [viewName, setViewName] = useState('');
  const [selectedViewId, setSelectedViewId] = useState('');
  const [viewBusy, setViewBusy] = useState(false);
  const [viewLoading, setViewLoading] = useState(true);
  const [viewError, setViewError] = useState('');
  const [viewStatus, setViewStatus] = useState('');
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [moderatedViews, setModeratedViews] = useState([]);
  const [moderationAudit, setModerationAudit] = useState([]);
  const [moderationLoading, setModerationLoading] = useState(true);
  const [moderationRevision, setModerationRevision] = useState(0);
  const [moderationBusy, setModerationBusy] = useState(false);
  const [moderationError, setModerationError] = useState('');
  const [moderationStatus, setModerationStatus] = useState('');
  const [moderationTargetId, setModerationTargetId] = useState('');
  const [moderationReason, setModerationReason] = useState('');
  const [moderationArmed, setModerationArmed] = useState(false);
  const scope = [tenantId, userId, role, revision].join(':');
  const cursor = cursors[page] ?? null;
  const [reload, setReload] = useState(0);
  const headingRef = useRef(null);
  const errorActionRef = useRef(null);
  const focusOnNavigation = useRef(false);
  const requestKey = reviewQueueRequestKey(page, cursor, reload, workType, reviewState, priority, dueWindow, titleQuery, sortMode);
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
    api.request(reviewQueueUrl(cursor, workType, reviewState, priority, dueWindow, titleQuery, sortMode), { silent: true, signal: controller.signal })
      .then(result => {
        const validated = validateReviewQueue(result);
        if (active) setRequestState({ key: requestKey, phase: 'ready', result: validated });
      })
      .catch(err => {
        if (active) setRequestState({ key: requestKey, phase: 'error',
          failure: reviewQueueFailure(err, cursor !== null) });
      });
    return () => { active = false; controller.abort(); };
  }, [api, available, cursor, requestKey, workType, reviewState, priority, dueWindow, titleQuery, sortMode, tenantId, userId, scope]);

  useEffect(() => {
    if (!available) return undefined;
    let active = true;
    const controller = new AbortController();
    setViewLoading(true);
    api.request(REVIEW_VIEWS_PATH, {silent:true, signal:controller.signal})
      .then(response => {
        const views = validateSavedViews(response);
        if (active) {
          setSavedViews(views);
          setViewLoading(false);
          setViewError('');
        }
      })
      .catch(error => {
        if (active) {
          setViewLoading(false);
          setViewError(error?.message || 'No se pudieron recuperar tus vistas.');
        }
      });
    return () => { active = false; controller.abort(); };
  }, [api, available, scope]);

  useEffect(() => {
    if (!available || role !== 'tenant_admin') return undefined;
    let active = true;
    const controller = new AbortController();
    setModerationLoading(true);
    Promise.all([
      api.request(REVIEW_MODERATION_PATH, {silent:true,signal:controller.signal})
        .then(validateModerationInventory),
      api.request(REVIEW_MODERATION_PATH + '/audit', {silent:true,signal:controller.signal})
        .then(validateModerationAudit)
    ]).then(([inventory,events])=>{
      if(!active) return;
      setModeratedViews(inventory);
      setModerationAudit(events);
      setModerationLoading(false);
      setModerationError('');
    }).catch(err=>{
      if(!active) return;
      setModerationLoading(false);
      setModerationError(err?.message || 'No se pudo recuperar la moderación.');
    });
    return ()=>{active=false;controller.abort();};
  },[api,available,role,scope,moderationRevision]);

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
  const ownViews = savedViews.filter(view => view.source === 'mine');
  const sharedViews = savedViews.filter(view => view.source === 'shared');
  const selectedView = savedViews.find(view => view.id === selectedViewId);
  const canManageSelected = selectedView?.source === 'mine';
  // Server-authoritative state filter was applied before the bounded page.
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
  const commitTitleQuery = value => {
    setTitleError('');
    setDraftTitle(value);
    if (value === titleQuery) return;
    focusOnNavigation.current = false;
    setTitleQuery(value);
    setPage(0);
    setCursors([null]);
    setReload(previous => previous + 1);
  };
  const submitTitleSearch = event => {
    event.preventDefault();
    if (loading) return;
    try {
      commitTitleQuery(normalizeReviewTitleQuery(draftTitle));
    } catch {
      setTitleError('Escribí entre 2 y 64 caracteres, sin caracteres de control.');
    }
  };
  const clearTitleSearch = () => commitTitleQuery('');
  const saveView = async event => {
    event.preventDefault();
    if (viewBusy || viewLoading || !available || savedViews.filter(view=>view.source === 'mine').length >= REVIEW_VIEW_LIMIT) return;
    setViewError('');
    setViewStatus('');
    let name, filters;
    try {
      name = normalizeReviewViewName(viewName);
      filters = reviewViewFilters({workType,reviewState,priority,dueWindow,
        titleQuery,sortMode});
    } catch(error) {
      setViewError(error.message);
      return;
    }
    setViewBusy(true);
    try {
      const result = validateSavedView(await api.request(REVIEW_VIEWS_PATH, {
        method:'POST', silent:true, body:{name,filters}
      }));
      setSavedViews(previous => [result,...previous]);
      setSelectedViewId(result.id);
      setViewName('');
      setDeleteArmed(false);
      setViewStatus('Vista guardada. Podés recuperarla en tu próxima sesión.');
    } catch(error) {
      setViewError(error?.message || 'No se pudo guardar la vista.');
    } finally {
      setViewBusy(false);
    }
  };
  const applyView = () => {
    if (viewBusy || viewLoading || loading) return;
    const selected = savedViews.find(item => item.id === selectedViewId);
    if (!selected) return;
    let filters;
    try { filters = reviewViewFilters(selected.filters); }
    catch { setViewError('La vista guardada ya no es válida.'); return; }
    focusOnNavigation.current = false;
    setWorkType(filters.workType);
    setReviewState(filters.reviewState);
    setPriority(filters.priority);
    setDueWindow(filters.dueWindow);
    setTitleQuery(filters.titleQuery);
    setDraftTitle(filters.titleQuery);
    setSortMode(filters.sortMode);
    setTitleError('');
    setPage(0);
    setCursors([null]);
    setReload(value => value + 1);
    setDeleteArmed(false);
    setViewError('');
    setViewStatus('Vista aplicada. Se inició una consulta nueva.');
  };
  const removeView = async () => {
    if (viewBusy || viewLoading || !deleteArmed || !selectedViewId || !canManageSelected) return;
    setViewBusy(true);
    setViewError('');
    setViewStatus('');
    try {
      await api.request(REVIEW_VIEWS_PATH + '/' + encodeURIComponent(selectedViewId), {
        method:'DELETE', silent:true
      });
      setSavedViews(previous => previous.filter(item => item.id !== selectedViewId));
      setSelectedViewId('');
      setDeleteArmed(false);
      setViewStatus('Vista eliminada. Los filtros actuales no cambiaron.');
    } catch(error) {
      setViewError(error?.message || 'No se pudo eliminar la vista.');
    } finally {
      setViewBusy(false);
    }
  };
  const changeViewVisibility = async visibility => {
    if (viewBusy || viewLoading || role !== 'tenant_admin' ||
        !canManageSelected || selectedView.visibility === visibility) return;
    setViewBusy(true);
    setViewError('');
    setViewStatus('');
    try {
      const result = validateSavedView(await api.request(
        REVIEW_VIEWS_PATH + '/' + encodeURIComponent(selectedViewId) + '/visibility', {
          method:'PATCH', silent:true, body:{visibility}
        }));
      setSavedViews(previous => previous.map(view =>
        view.id === selectedViewId ? result : view));
      setDeleteArmed(false);
      setViewStatus(visibility === 'shared'
        ? 'Vista compartida con coordinación de esta empresa.'
        : 'Vista nuevamente privada para tu usuario.');
    } catch(error) {
      setViewError(error?.message || 'No se pudo cambiar la visibilidad de la vista.');
    } finally {
      setViewBusy(false);
    }
  };
  const chooseModeration = id => {
    if (moderationBusy) return;
    setModerationTargetId(id);
    setModerationReason('');
    setModerationArmed(false);
    setModerationError('');
    setModerationStatus('');
  };
  const prepareModeration = event => {
    event.preventDefault();
    if (moderationBusy || moderationLoading || role !== 'tenant_admin') return;
    if (!moderatedViews.some(view => view.id === moderationTargetId)) return;
    try { normalizeModerationReason(moderationReason); }
    catch { setModerationError('Ingresá un motivo de 8 a 200 caracteres.'); return; }
    setModerationError('');
    setModerationArmed(true);
  };
  const confirmModeration = async () => {
    if (moderationBusy || moderationLoading || role !== 'tenant_admin' ||
        !moderationArmed || !moderatedViews.some(view => view.id === moderationTargetId)) return;
    let reason;
    try { reason = normalizeModerationReason(moderationReason); }
    catch { setModerationError('Ingresá un motivo de 8 a 200 caracteres.'); return; }
    setModerationBusy(true);
    setModerationError('');
    setModerationStatus('');
    try {
      const event=validateModerationRevoke(await api.request(
        REVIEW_MODERATION_PATH + '/' + encodeURIComponent(moderationTargetId) + '/revoke', {
          method:'POST',silent:true,body:{reason}
        }));
      setSavedViews(previous=>previous.filter(view=>view.id!==moderationTargetId));
      setSelectedViewId(previous=>previous===moderationTargetId?'':previous);
      setModerationTargetId('');
      setModerationReason('');
      setModerationArmed(false);
      setModerationAudit(previous=>[event,...previous].slice(0,50));
      setModeratedViews(previous=>previous.filter(view=>view.id!==event.view_id));
      setModerationRevision(previous=>previous+1);
      setModerationStatus('Publicación revocada y auditoría registrada. La vista sigue siendo privada de su autor.');
    } catch(err) {
      setModerationError(err?.message || 'No se pudo revocar la publicación.');
      setModerationArmed(false);
      setModerationRevision(previous=>previous+1);
    } finally {
      setModerationBusy(false);
    }
  };
  const changeReviewState = nextState => {
    if (!Object.hasOwn(REVIEW_QUEUE_PAGE_FILTERS, nextState) || nextState === reviewState) return;
    focusOnNavigation.current = false;
    setReviewState(nextState);
    setPage(0);
    setCursors([null]);
    setReload(value => value + 1);
  };
  const changeSortMode = nextSort => {
    if (!Object.hasOwn(REVIEW_QUEUE_SORT_MODES, nextSort) ||
        nextSort === sortMode || loading) return;
    focusOnNavigation.current = false;
    setSortMode(nextSort);
    setPage(0);
    setCursors([null]);
    setReload(value => value + 1);
  };
  const changeDueWindow = nextWindow => {
    if (!Object.hasOwn(REVIEW_QUEUE_DUE_WINDOWS, nextWindow) ||
        nextWindow === dueWindow || loading) return;
    focusOnNavigation.current = false;
    setDueWindow(nextWindow);
    setPage(0);
    setCursors([null]);
    setReload(value => value + 1);
  };
  const changePriority = nextPriority => {
    if (!Object.hasOwn(REVIEW_QUEUE_PRIORITIES, nextPriority) ||
        nextPriority === priority || loading) return;
    focusOnNavigation.current = false;
    setPriority(nextPriority);
    setPage(0);
    setCursors([null]);
    setReload(value => value + 1);
  };
  const changeWorkType = nextType => {
    if (!Object.hasOwn(REVIEW_QUEUE_WORK_TYPES, nextType) || nextType === workType) return;
    focusOnNavigation.current = false;
    setWorkType(nextType);
    setPage(0);
    setCursors([null]);
    setReviewState('all');
    setReload(value => value + 1);
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
        ? <button type="button" ref={errorActionRef} className="ghost-action"
          onClick={refresh}>Iniciar nueva consulta</button>
        : <button type="button" ref={errorActionRef} className="ghost-action"
          onClick={() => setReload(value => value + 1)}>Reintentar</button>}
    </div>}
    <div className="orders-workspace__review-saved-views" aria-label="Mis vistas guardadas">
      <h3>Mis vistas guardadas</h3>
      <p>Hasta diez combinaciones de filtros tuyas, privadas por defecto.
        Administración puede compartirlas con coordinadores de esta empresa.
        No se comparten órdenes, permisos ni cursores de navegación.</p>
      {viewLoading && <p role="status">Recuperando vistas guardadas…</p>}
      {viewError && <p role="alert">{viewError}</p>}
      {viewStatus && <p role="status">{viewStatus}</p>}
      <form onSubmit={saveView} className="orders-workspace__review-save-form">
        <label htmlFor="review-view-name">Nombre de la nueva vista</label>
        <input id="review-view-name" type="text" maxLength={48} value={viewName}
          disabled={viewBusy || viewLoading} onChange={event => setViewName(event.target.value)}
          placeholder="Ej.: Inspecciones urgentes" />
        <button type="submit" className="ghost-action"
          disabled={viewBusy || viewLoading || savedViews.filter(view=>view.source === 'mine').length >= REVIEW_VIEW_LIMIT}>
          Guardar filtros actuales
        </button>
      </form>
      <p>{ownViews.length} de {REVIEW_VIEW_LIMIT} vistas guardadas.</p>
      <p>{sharedViews.length} vistas compartidas por administración disponibles.</p>
      <label htmlFor="review-view-select">Elegir vista guardada</label>
      <select id="review-view-select" value={selectedViewId}
        disabled={viewBusy || viewLoading || !savedViews.length}
        onChange={event => { setSelectedViewId(event.target.value); setDeleteArmed(false); }}>
        <option value="">Seleccioná una vista</option>
        <optgroup label="Mis vistas">
          {ownViews.map(view => <option key={view.id} value={view.id}>
            {view.name}{view.visibility === 'shared' ? ' (compartida)' : ''}
          </option>)}
        </optgroup>
        <optgroup label="Compartidas con coordinación">
          {sharedViews.map(view => <option key={view.id} value={view.id}>
            {view.name} (compartida)
          </option>)}
        </optgroup>
      </select>
      <div className="orders-workspace__review-save-actions">
        <button type="button" className="ghost-action" onClick={applyView}
          disabled={!selectedViewId || viewBusy || viewLoading || loading}>Aplicar vista</button>
        {!deleteArmed
          ? <button type="button" className="ghost-action"
            disabled={!canManageSelected || viewBusy || viewLoading}
            onClick={() => setDeleteArmed(true)}>Eliminar vista…</button>
          : <>
            <span>¿Eliminar esta vista guardada?</span>
            <button type="button" className="ghost-action"
              disabled={viewBusy} onClick={removeView}>Confirmar eliminación</button>
            <button type="button" className="ghost-action"
              disabled={viewBusy} onClick={() => setDeleteArmed(false)}>Cancelar</button>
          </>}
      </div>
      {role === 'tenant_admin' && canManageSelected && <div
        className="orders-workspace__review-share-actions">
        {selectedView.visibility === 'private'
          ? <button type="button" className="ghost-action" disabled={viewBusy || viewLoading}
              onClick={() => changeViewVisibility('shared')}>Compartir con coordinación</button>
          : <button type="button" className="ghost-action" disabled={viewBusy || viewLoading}
              onClick={() => changeViewVisibility('private')}>Dejar de compartir</button>}
      </div>}
      {selectedView?.source === 'shared' &&
        <p>Esta vista es de solo lectura: podés aplicarla, pero no editarla ni eliminarla.</p>}
    </div>
    {role === 'tenant_admin' && <section className="orders-workspace__review-moderation"
      aria-labelledby="review-moderation-title">
      <h3 id="review-moderation-title">Moderación de vistas compartidas</h3>
      <p>Podés retirar una publicación ajena de esta empresa con un motivo.
        No modifica ni elimina los filtros privados de su autor.</p>
      {moderationLoading && <p role="status">Cargando publicaciones y auditoría…</p>}
      {moderationError && <p role="alert">{moderationError}</p>}
      {moderationStatus && <p role="status">{moderationStatus}</p>}
      <p>{moderatedViews.length} publicaciones ajenas visibles para moderación.</p>
      <form className="orders-workspace__review-moderation-form" onSubmit={prepareModeration}>
        <label htmlFor="review-moderation-target">Publicación a revisar</label>
        <select id="review-moderation-target" value={moderationTargetId}
          disabled={moderationLoading || moderationBusy}
          onChange={event=>chooseModeration(event.target.value)}>
          <option value="">Seleccioná una vista compartida</option>
          {moderatedViews.map(view=><option key={view.id} value={view.id}>
            {view.name}{view.publisher_active?'':' (autor sin rol activo)'}
          </option>)}
        </select>
        <label htmlFor="review-moderation-reason">Motivo de revocación</label>
        <textarea id="review-moderation-reason" value={moderationReason}
          maxLength={200} rows={2}
          disabled={moderationLoading || moderationBusy}
          onChange={event=>{setModerationReason(event.target.value);setModerationArmed(false);}} />
        {!moderationArmed
          ? <button type="submit" className="ghost-action"
              disabled={!moderationTargetId || moderationLoading || moderationBusy}>
              Revisar revocación</button>
          : <div className="orders-workspace__review-moderation-actions">
            <p>¿Confirmás retirar esta vista compartida? El evento será auditado.</p>
            <button type="button" className="ghost-action" disabled={moderationBusy}
              onClick={confirmModeration}>Confirmar revocación</button>
            <button type="button" className="ghost-action" disabled={moderationBusy}
              onClick={()=>setModerationArmed(false)}>Cancelar revocación</button>
          </div>}
      </form>
      <button type="button" className="ghost-action" disabled={moderationLoading || moderationBusy}
        onClick={()=>setModerationRevision(previous=>previous+1)}>
        Actualizar publicaciones y auditoría
      </button>
      <details>
        <summary>Historial de revocaciones (últimas 50)</summary>
        {moderationAudit.length===0 && <p>Sin revocaciones registradas.</p>}
        <ul>
          {moderationAudit.map(event=><li key={event.id}>
            <strong>{event.view_name}</strong>: {event.reason}.
            {' '}Fecha: {event.created_at}.
            {' '}Administrador: {event.actor_user_id}.
            {' '}Propietario: {event.view_owner_id}.
          </li>)}
        </ul>
      </details>
    </section>}
    <div className="orders-workspace__review-global-filter">
      <form className="orders-workspace__review-title-search" role="search"
        onSubmit={submitTitleSearch}>
        <label htmlFor="review-queue-title-search">Buscar por título (todas las páginas)</label>
        <input id="review-queue-title-search" type="search" value={draftTitle}
          maxLength={64} disabled={loading} aria-describedby="review-queue-title-hint"
          onChange={event => { setDraftTitle(event.target.value); setTitleError(''); }} />
        <div className="orders-workspace__review-search-actions">
          <button type="submit" className="ghost-action" disabled={loading}>
            Buscar órdenes
          </button>
          <button type="button" className="ghost-action" disabled={loading || (!draftTitle && !titleQuery)}
            onClick={clearTitleSearch}>Limpiar búsqueda</button>
        </div>
        <p id="review-queue-title-hint">Busca una frase literal del título en todas
          las órdenes autorizadas; no busca en partes ni evidencias privadas.</p>
        {titleError && <p role="alert">{titleError}</p>}
        {titleQuery && <p role="status">Búsqueda activa por título: {titleQuery}</p>}
      </form>
      <label htmlFor="review-queue-sort">Ordenar resultados (todas las páginas)</label>
      <select id="review-queue-sort" value={sortMode} disabled={loading}
        onChange={event => changeSortMode(event.target.value)}>
        {Object.entries(REVIEW_QUEUE_SORT_MODES).map(([code, label]) =>
          <option key={code} value={code}>{label}</option>)}
      </select>
      <p>Orden global real: vencimientos sin fecha al final y desempate por
        creación y código. Cambiar el orden inicia una consulta nueva.</p>
      <label htmlFor="review-queue-work-type">Tipo de labor (todas las páginas)</label>
      <select id="review-queue-work-type" value={workType}
        disabled={loading} onChange={event => changeWorkType(event.target.value)}>
        {Object.entries(REVIEW_QUEUE_WORK_TYPES).map(([code, label]) =>
          <option key={code} value={code}>{label}</option>)}
      </select>
      <label htmlFor="review-queue-priority">Prioridad (todas las páginas)</label>
      <select id="review-queue-priority" value={priority} disabled={loading}
        onChange={event => changePriority(event.target.value)}>
        {Object.entries(REVIEW_QUEUE_PRIORITIES).map(([code, label]) =>
          <option key={code} value={code}>{label}</option>)}
      </select>
      <label htmlFor="review-queue-due-window">Vencimiento (todas las páginas)</label>
      <select id="review-queue-due-window" value={dueWindow} disabled={loading}
        onChange={event => changeDueWindow(event.target.value)}>
        {Object.entries(REVIEW_QUEUE_DUE_WINDOWS).map(([code, label]) =>
          <option key={code} value={code}>{label}</option>)}
      </select>
      <p>El título, tipo, estado, prioridad y vencimiento se filtran en el servidor
        antes de paginar. Las ventanas toman la hora de inicio de la consulta.
        Ningún filtro autoriza aprobaciones ni cambia fechas.</p>
    </div>
    {!loading && !error && shown && <>
      <p role="status" aria-live="polite" className="orders-workspace__review-announcement">
        Página {page + 1}. {items.length} órdenes en esta página.
      </p>
      <fieldset className="orders-workspace__review-filters" disabled={loading}>
        <legend>Estado de revisión (todas las páginas)</legend>
        <div className="orders-workspace__review-filter-options">
          {Object.entries(REVIEW_QUEUE_PAGE_FILTERS).map(([key, option]) =>
            <button key={key} type="button" className={`ghost-action ${reviewState === key
              ? 'orders-workspace__review-filter--active' : ''}`}
              aria-pressed={reviewState === key} onClick={() => changeReviewState(key)}>
              {option.label}
            </button>)}
        </div>
      </fieldset>
      <p role="status" aria-live="polite" className="orders-workspace__review-announcement">
        {items.length} órdenes coincidentes en esta página de resultados.
        El filtro de estado abarca todas las páginas autorizadas.
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
