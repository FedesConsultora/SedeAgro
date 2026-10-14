import { useCallback, useEffect, useState } from 'react';

// A single, fail-closed contract for lists in authenticated business modules.
// Demo data is used ONLY when the user explicitly selected mock mode.
export function extractCollection(response, title = 'recurso') {
  if (!Array.isArray(response?.data)) {
    throw new Error('La respuesta de ' + title + ' no tiene una lista válida.');
  }
  return response.data;
}

export function useTenantCollection({ api, method, dataMode, tenantId, mockRecords, title }) {
  const scope = dataMode === 'mock' ? 'demo' : tenantId;
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState(() => ({
    scope: null, status: 'loading', records: [], error: null
  }));
  const reload = useCallback(() => setRevision(value => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    setState({ scope, status: 'loading', records: [], error: null });
    if (dataMode === 'mock') {
      setState({ scope, status: 'ready', records: mockRecords, error: null });
      return () => { cancelled = true; };
    }
    if (!scope) {
      setState({ scope, status: 'error', records: [],
        error: 'No se pudo identificar la empresa activa.' });
      return () => { cancelled = true; };
    }
    Promise.resolve().then(() => api[method]()).then(response => {
      if (!cancelled) setState({ scope, status: 'ready',
        records: extractCollection(response, title), error: null });
    }).catch(error => {
      if (!cancelled) setState({ scope, status: 'error', records: [],
        error: error?.message || 'No se pudo consultar ' + title + '.' });
    });
    return () => { cancelled = true; };
  }, [api, method, dataMode, scope, mockRecords, title, revision]);

  if (state.scope !== scope) return { records: [], loading: true, error: null, reload };
  return {
    records: state.status === 'ready' ? state.records : [],
    loading: state.status === 'loading',
    error: state.status === 'error' ? state.error : null,
    reload
  };
}
