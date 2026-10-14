import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, ChevronRight, RefreshCw, X } from 'lucide-react';
import { useSession } from '../context/SessionContext.jsx';
import {
  notificationScope, parseNotificationList, parseReadReceipt,
  notificationDestination, unreadNotifications
} from '../services/notificationInbox.js';
import './field-status.css';

function timeLabel(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Fecha no disponible'
    : date.toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
}

export function NotificationCenter({ onViewChange }) {
  const { api, session, dataMode, entitlements } = useSession();
  const scope = notificationScope(session, dataMode);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState({ scope: null, phase: 'loading', rows: [], error: '' });
  const [readWorking, setReadWorking] = useState(null);
  const [actionError, setActionError] = useState('');
  const requestNumber = useRef(0);
  const scopeRef = useRef(scope);
  const wrapperRef = useRef(null);
  scopeRef.current = scope;

  const load = useCallback(async () => {
    const requestId = ++requestNumber.current;
    if (!scope) {
      setState({ scope: null, phase: 'unavailable', rows: [], error: '' });
      return;
    }
    setState({ scope, phase: 'loading', rows: [], error: '' });
    try {
      const response = await api.notifications();
      const rows = parseNotificationList(response, session);
      if (requestNumber.current === requestId && scopeRef.current === scope) {
        setState({ scope, phase: 'ready', rows, error: '' });
      }
    } catch (error) {
      if (requestNumber.current === requestId && scopeRef.current === scope) {
        setState({ scope, phase: 'error', rows: [],
          error: error?.message || 'No se pudieron consultar las notificaciones.' });
      }
    }
  }, [api, scope, session]);

  useEffect(() => {
    void load();
    return () => { requestNumber.current += 1; };
  }, [load]);

  // A changed actor or tenant invalidates all pending interactions as well as
  // loaded rows. Never allow an old PATCH response to update the new inbox.
  useEffect(() => {
    setOpen(false);
    setReadWorking(null);
    setActionError('');
  }, [scope]);

  useEffect(() => {
    if (!scope) return undefined;
    const updateOnResume = () => {
      if (document.visibilityState === 'visible' && navigator.onLine !== false) void load();
    };
    window.addEventListener('online', updateOnResume);
    document.addEventListener('visibilitychange', updateOnResume);
    return () => {
      window.removeEventListener('online', updateOnResume);
      document.removeEventListener('visibilitychange', updateOnResume);
    };
  }, [scope, load]);

  useEffect(() => {
    if (!open) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const closeOutside = (event) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener('keydown', closeOnEscape);
    document.addEventListener('pointerdown', closeOutside);
    return () => {
      document.removeEventListener('keydown', closeOnEscape);
      document.removeEventListener('pointerdown', closeOutside);
    };
  }, [open]);

  const current = state.scope === scope ? state :
    { scope, phase: 'loading', rows: [], error: '' };
  const count = current.phase === 'ready' ? unreadNotifications(current.rows) : null;
  const access = {
    role: session?.membership?.roleCode || '',
    platformAdmin: Boolean(session?.user?.isPlatformAdmin),
    entitlements
  };

  const markRead = async (item) => {
    if (readWorking || !scope || current.phase !== 'ready' || item.read_at) return;
    const requestedScope = scope;
    setReadWorking(item.id);
    setActionError('');
    try {
      const result = await api.markNotificationRead(item.id);
      const confirmed = parseReadReceipt(result, item, session);
      if (scopeRef.current !== requestedScope) return;
      setState((existing) => existing.scope === requestedScope && existing.phase === 'ready'
        ? { ...existing, rows: existing.rows.map(row => row.id === item.id ? confirmed : row) }
        : existing);
    } catch (err) {
      if (scopeRef.current === requestedScope) {
        setActionError(err?.message || 'No se pudo confirmar la lectura. Reintentá.');
      }
    } finally {
      if (scopeRef.current === requestedScope) setReadWorking(null);
    }
  };

  return (
    <div className="notification-center" ref={wrapperRef}>
      <button className={count !== null && count > 0 ? 'icon-button icon-button--has-badge' : 'icon-button'}
        type="button" title="Notificaciones" aria-label={count === null
          ? 'Abrir notificaciones' : `Notificaciones: ${count} sin leer`}
        data-count={count !== null && count > 99 ? '99+' : count || undefined}
        aria-expanded={open} aria-controls="sedeagro-inbox"
        onClick={() => { setOpen(value => !value); setActionError(''); }}>
        <Bell size={18} aria-hidden="true" />
      </button>

      {open && <section id="sedeagro-inbox" className="notification-center__panel"
        aria-label="Bandeja de notificaciones">
        <header className="notification-center__header">
          <div><strong>Notificaciones</strong>
            <span>{dataMode === 'mock' ? 'Vista de demostración' :
              count === null ? 'Sin consulta confirmada' : `${count} sin leer`}</span>
          </div>
          <div className="notification-center__actions">
            {scope && <button type="button" className="ghost-action"
              disabled={current.phase === 'loading'} onClick={() => void load()}>
              <RefreshCw size={14} /> Actualizar
            </button>}
            <button type="button" className="icon-button" title="Cerrar notificaciones"
              aria-label="Cerrar notificaciones" onClick={() => setOpen(false)}><X size={16}/></button>
          </div>
        </header>
        {!scope && <p className="notification-center__hint" role="status">
          {dataMode === 'mock' ? 'No hay avisos reales en modo demostración.' :
            'Iniciá sesión en tu empresa para consultar las notificaciones.'}
        </p>}
        {scope && current.phase === 'loading' && <p className="notification-center__hint" role="status">
          Consultando notificaciones…
        </p>}
        {scope && current.phase === 'error' && <div className="notification-center__error" role="alert">
          <span>{current.error}</span>
          <button type="button" className="ghost-action" onClick={() => void load()}>Reintentar</button>
        </div>}
        {actionError && <p className="notification-center__error" role="alert">{actionError}</p>}
        {scope && current.phase === 'ready' && (current.rows.length === 0
          ? <p className="notification-center__hint" role="status">
              No hay notificaciones registradas en esta cuenta.
            </p>
          : <ul className="notification-center__list">
              {current.rows.map(item => {
                const destination = notificationDestination(item, access);
                return <li key={item.id} className={item.read_at
                  ? 'notification-center__item' : 'notification-center__item notification-center__item--unread'}>
                  <div className="notification-center__item-heading">
                    <strong>{item.title}</strong>
                    <time dateTime={item.created_at}>{timeLabel(item.created_at)}</time>
                  </div>
                  {item.body && <p>{item.body}</p>}
                  <div className="notification-center__item-actions">
                    {destination && <button type="button" className="ghost-action" onClick={() => {
                      setOpen(false);
                      onViewChange?.(destination.view, { id: destination.id });
                    }}>Ver registro <ChevronRight size={14} /></button>}
                    {!item.read_at && <button type="button" className="ghost-action"
                      disabled={Boolean(readWorking)}
                      onClick={() => void markRead(item)}>
                      {readWorking === item.id ? 'Confirmando…' : 'Marcar como leída'}
                    </button>}
                    {item.read_at && <span className="notification-center__read-label">Leída</span>}
                  </div>
                </li>;
              })}
            </ul>)}
        {scope && current.phase === 'ready' && current.rows.length === 50 &&
          <p className="notification-center__hint">Se muestran los 50 avisos más recientes.</p>}
      </section>}
    </div>
  );
}
