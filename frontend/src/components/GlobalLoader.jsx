import { LoaderCircle } from 'lucide-react';
import { useFeedback } from '../context/FeedbackContext.jsx';

export function GlobalLoader() {
  const { isLoading } = useFeedback();
  if (!isLoading) return null;

  return (
    <div className="global-loader" role="status" aria-live="polite">
      <LoaderCircle size={18} />
      <span>Cargando</span>
    </div>
  );
}
