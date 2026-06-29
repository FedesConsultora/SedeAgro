import { createContext, useCallback, useContext, useMemo, useState } from 'react';

const FeedbackContext = createContext(null);

export function FeedbackProvider({ children }) {
  const [pendingCount, setPendingCount] = useState(0);
  const [error, setError] = useState(null);

  const startLoading = useCallback(() => {
    setPendingCount((count) => count + 1);
  }, []);

  const stopLoading = useCallback(() => {
    setPendingCount((count) => Math.max(0, count - 1));
  }, []);

  const showError = useCallback((nextError) => {
    setError(nextError);
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const value = useMemo(() => ({
    isLoading: pendingCount > 0,
    pendingCount,
    error,
    startLoading,
    stopLoading,
    showError,
    clearError
  }), [pendingCount, error, startLoading, stopLoading, showError, clearError]);

  return <FeedbackContext.Provider value={value}>{children}</FeedbackContext.Provider>;
}

export function useFeedback() {
  const value = useContext(FeedbackContext);
  if (!value) throw new Error('useFeedback debe usarse dentro de FeedbackProvider');
  return value;
}
