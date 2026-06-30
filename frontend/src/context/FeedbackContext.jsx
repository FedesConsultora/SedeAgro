import { createContext, useCallback, useContext, useMemo, useReducer, useRef } from 'react';

const FeedbackContext = createContext(null);

// ── Toast types ───────────────────────────────────────────────
// success | error | warning | info
const MAX_TOASTS = 5;
const AUTO_DISMISS_MS = { success: 4000, info: 5000, warning: 6000, error: 8000 };

let toastId = 0;

function toastsReducer(state, action) {
  switch (action.type) {
    case 'ADD':
      return [...state, action.toast].slice(-MAX_TOASTS);
    case 'REMOVE':
      return state.filter((t) => t.id !== action.id);
    case 'CLEAR':
      return [];
    default:
      return state;
  }
}

export function FeedbackProvider({ children }) {
  const [pendingCount, dispatchLoading] = useReducer((s, a) => (a === 'start' ? s + 1 : Math.max(0, s - 1)), 0);
  const [toasts, dispatchToasts] = useReducer(toastsReducer, []);
  const timersRef = useRef({});

  // ── Loading ─────────────────────────────────────────────────
  const startLoading = useCallback(() => dispatchLoading('start'), []);
  const stopLoading = useCallback(() => dispatchLoading('stop'), []);

  // ── Remove toast ────────────────────────────────────────────
  const removeToast = useCallback((id) => {
    dispatchToasts({ type: 'REMOVE', id });
    if (timersRef.current[id]) {
      clearTimeout(timersRef.current[id]);
      delete timersRef.current[id];
    }
  }, []);

  // ── Add toast ───────────────────────────────────────────────
  const addToast = useCallback((toast) => {
    const id = ++toastId;
    const level = toast.level || 'info';
    const entry = { id, level, ...toast, createdAt: Date.now() };

    dispatchToasts({ type: 'ADD', toast: entry });

    // Auto-dismiss
    const duration = toast.duration ?? AUTO_DISMISS_MS[level] ?? 5000;
    if (duration > 0) {
      timersRef.current[id] = setTimeout(() => {
        removeToast(id);
      }, duration);
    }

    return id;
  }, [removeToast]);

  // ── Convenience helpers ─────────────────────────────────────
  const showSuccess = useCallback((message, opts = {}) => {
    return addToast({ level: 'success', title: opts.title || 'Listo', message, ...opts });
  }, [addToast]);

  const showError = useCallback((errorOrMessage, opts = {}) => {
    // Accept string, Error instance, or {title, message, ...} object
    if (typeof errorOrMessage === 'string') {
      return addToast({ level: 'error', title: opts.title || 'Error', message: errorOrMessage, ...opts });
    }
    const err = errorOrMessage || {};
    return addToast({
      level: 'error',
      title: err.title || `Error ${err.status || ''}`.trim(),
      message: err.message || 'Ocurrió un error inesperado.',
      hint: err.hint || null,
      code: err.code || null,
      requestId: err.requestId || null,
      details: err.details || null,
      ...opts
    });
  }, [addToast]);

  const showWarning = useCallback((message, opts = {}) => {
    return addToast({ level: 'warning', title: opts.title || 'Atención', message, ...opts });
  }, [addToast]);

  const showInfo = useCallback((message, opts = {}) => {
    return addToast({ level: 'info', title: opts.title || 'Información', message, ...opts });
  }, [addToast]);

  const clearAll = useCallback(() => {
    Object.values(timersRef.current).forEach(clearTimeout);
    timersRef.current = {};
    dispatchToasts({ type: 'CLEAR' });
  }, []);

  // ── Context value ───────────────────────────────────────────
  const value = useMemo(() => ({
    isLoading: pendingCount > 0,
    pendingCount,
    toasts,
    startLoading,
    stopLoading,
    addToast,
    removeToast,
    showSuccess,
    showError,
    showWarning,
    showInfo,
    clearAll
  }), [pendingCount, toasts, startLoading, stopLoading, addToast, removeToast, showSuccess, showError, showWarning, showInfo, clearAll]);

  return <FeedbackContext.Provider value={value}>{children}</FeedbackContext.Provider>;
}

export function useFeedback() {
  const value = useContext(FeedbackContext);
  if (!value) throw new Error('useFeedback debe usarse dentro de FeedbackProvider');
  return value;
}
