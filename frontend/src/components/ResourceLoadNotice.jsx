import { AlertCircle, RefreshCw } from 'lucide-react';

export function ResourceLoadNotice({ title, error, onRetry }) {
  if (!error) return null;
  return (
    <section role="alert" className="resource-load-notice">
      <AlertCircle size={18} aria-hidden="true" />
      <div>
        <strong>No se pudieron cargar {title}.</strong>
        <p>{error}</p>
        <p>Los datos de demostración no reemplazan los resultados de tu empresa.</p>
      </div>
      <button type="button" className="ghost-action" onClick={onRetry}>
        <RefreshCw size={15} aria-hidden="true" /> Reintentar
      </button>
    </section>
  );
}
