import { useCallback, useEffect, useRef, useState } from 'react';
import { checkedTenantCollectionRows, visibleTenantCollectionState } from './tenantCollectionRenderSafety.js';

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
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const apiRef = useRef(api);
  apiRef.current = api;
  const revisionRef = useRef(revision);
  revisionRef.current = revision;
  const [state, setState] = useState(() => ({
    scope: null, api: null, revision: -1,
    status: 'loading', records: [], error: null
  }));
  const reload = useCallback(() => setRevision(value => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    const current = () => !cancelled && scopeRef.current === scope &&
      apiRef.current === api && revisionRef.current === revision;
    setState({ scope, api, revision, status: 'loading', records: [], error: null });
    if (dataMode === 'mock') {
      setState({ scope, api, revision, status: 'ready', records: mockRecords, error: null });
      return () => { cancelled = true; };
    }
    if (!scope) {
      setState({ scope, api, revision, status: 'error', records: [],
        error: 'No se pudo identificar la empresa activa.' });
      return () => { cancelled = true; };
    }
    Promise.resolve().then(() => {
      if (!current()) return null;
      return api[method]();
    }).then(response => {
      if (!current() || response === null) return;
      const records = checkedTenantCollectionRows(extractCollection(response, title), scope, title);
      if (current()) setState({ scope, api, revision, status: 'ready', records, error: null });
    }).catch(error => {
      if (current()) setState({ scope, api, revision, status: 'error', records: [],
        error: error?.message || 'No se pudo consultar ' + title + '.' });
    });
    return () => { cancelled = true; };
  }, [api, method, dataMode, scope, mockRecords, title, revision]);

  const visible = visibleTenantCollectionState(state, scope, api, revision);
  if (!visible) return { records: [], loading: Boolean(scope), error:
    scope ? null : 'No se pudo identificar la empresa activa.', reload };
  return {
    records: visible.status === 'ready' ? visible.records : [],
    loading: visible.status === 'loading',
    error: visible.status === 'error' ? visible.error : null,
    reload
  };
}
