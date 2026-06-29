import { AlertTriangle, X } from 'lucide-react';
import { useFeedback } from '../context/FeedbackContext.jsx';

export function ErrorToast() {
  const { error, clearError } = useFeedback();
  if (!error) return null;

  return (
    <aside className="error-toast" role="alert">
      <AlertTriangle size={20} />
      <div>
        <strong>{error.title || 'No se pudo completar la acción'}</strong>
        <span>{error.message}</span>
        {error.requestId && <small>Referencia: {error.requestId}</small>}
      </div>
      <button type="button" onClick={clearError} title="Cerrar">
        <X size={16} />
      </button>
    </aside>
  );
}
