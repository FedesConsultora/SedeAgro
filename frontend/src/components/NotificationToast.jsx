import { useEffect, useRef } from 'react';
import { AlertTriangle, CheckCircle, Info, X, XCircle, Copy, ChevronDown, ChevronUp } from 'lucide-react';
import { useFeedback } from '../context/FeedbackContext.jsx';
import { useState } from 'react';

const LEVEL_CONFIG = {
  success: { icon: CheckCircle, label: 'Éxito' },
  error:   { icon: XCircle,     label: 'Error' },
  warning: { icon: AlertTriangle, label: 'Advertencia' },
  info:    { icon: Info,         label: 'Información' }
};

function ToastItem({ toast, onDismiss }) {
  const config = LEVEL_CONFIG[toast.level] || LEVEL_CONFIG.info;
  const Icon = config.icon;
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef(null);

  const hasDetails = toast.details || toast.code || toast.requestId || toast.hint;

  const copyRequestId = () => {
    if (toast.requestId) {
      navigator.clipboard.writeText(toast.requestId).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    }
  };

  // Animate in
  useEffect(() => {
    const el = ref.current;
    if (el) {
      requestAnimationFrame(() => {
        el.classList.add('toast-item--visible');
      });
    }
  }, []);

  return (
    <div className={`toast-item toast-item--${toast.level}`} ref={ref} role="alert">
      <div className="toast-item__icon">
        <Icon size={18} />
      </div>

      <div className="toast-item__body">
        <div className="toast-item__header">
          <strong className="toast-item__title">{toast.title || config.label}</strong>
          <div className="toast-item__actions">
            {hasDetails && (
              <button
                type="button"
                className="toast-item__action"
                onClick={() => setExpanded(!expanded)}
                title={expanded ? 'Ocultar detalles' : 'Ver detalles'}
              >
                {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </button>
            )}
            <button
              type="button"
              className="toast-item__action"
              onClick={() => onDismiss(toast.id)}
              title="Cerrar"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        <p className="toast-item__message">{toast.message}</p>

        {toast.hint && (
          <p className="toast-item__hint">💡 {toast.hint}</p>
        )}

        {expanded && hasDetails && (
          <div className="toast-item__details">
            {toast.code && (
              <div className="toast-item__detail-row">
                <span className="toast-item__detail-label">Código</span>
                <span className="toast-item__detail-value">{toast.code}</span>
              </div>
            )}
            {toast.requestId && (
              <div className="toast-item__detail-row">
                <span className="toast-item__detail-label">Referencia</span>
                <span className="toast-item__detail-value toast-item__detail-value--mono">
                  {toast.requestId.slice(0, 8)}…
                  <button type="button" className="toast-item__copy" onClick={copyRequestId} title="Copiar ID">
                    <Copy size={11} />
                    {copied && <span className="toast-item__copied">✓</span>}
                  </button>
                </span>
              </div>
            )}
            {toast.details && typeof toast.details === 'object' && toast.details.fieldErrors && (
              <div className="toast-item__field-errors">
                {Object.entries(toast.details.fieldErrors).map(([field, errors]) => (
                  <div key={field} className="toast-item__detail-row">
                    <span className="toast-item__detail-label">{field}</span>
                    <span className="toast-item__detail-value">{Array.isArray(errors) ? errors.join(', ') : String(errors)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function NotificationToast() {
  const { toasts, removeToast } = useFeedback();

  if (!toasts.length) return null;

  return (
    <div className="toast-stack" aria-live="polite" aria-label="Notificaciones">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={removeToast} />
      ))}
    </div>
  );
}
