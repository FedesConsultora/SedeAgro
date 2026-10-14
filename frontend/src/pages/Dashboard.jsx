import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, ArrowRight, CalendarDays, ClipboardList, Compass, MapPinned, RefreshCw, ShieldAlert } from 'lucide-react';
import { useSession } from '../context/SessionContext.jsx';
import { mockData } from '../services/mockData.js';
import {
  accessibleHomeKeys, decodeHomeCollection, emptyHomeResources, homeSnapshot
} from '../services/operationsHome.js';
import './operations-home.css';

const RESOURCES = {
  fields: { label: 'Lotes', method: 'fields', view: 'fields', icon: MapPinned },
  campaigns: { label: 'Campañas', method: 'campaigns', view: 'campaigns', icon: CalendarDays },
  scoutingRuns: { label: 'Monitoreo', method: 'scoutingRuns', view: 'scouting', icon: Compass },
  orders: { label: 'Órdenes', method: 'workOrders', view: 'orders', icon: ClipboardList }
};
const DEMO_DATA = {
  fields: mockData.fields, campaigns: mockData.campaigns,
  scoutingRuns: mockData.scoutingRuns, orders: mockData.workOrders
};

export function Dashboard({ onNavigate }) {
  const { api, dataMode, session, entitlements } = useSession();
  const role = session?.membership?.roleCode || '';
  const keys = useMemo(() => dataMode === 'mock'
    ? Object.keys(RESOURCES) : accessibleHomeKeys(entitlements, role),
    [dataMode, entitlements, role]);
  const [resources, setResources] = useState(emptyHomeResources);
  const [isLoading, setIsLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [loadedAt, setLoadedAt] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setLoadedAt(null);
    setResources(Object.fromEntries(Object.keys(RESOURCES).map(key => [
      key, { state: keys.includes(key) ? 'loading' : 'unavailable', data: [] }
    ])));

    if (dataMode === 'mock') {
      setResources(Object.fromEntries(keys.map(key => [
        key, { state: 'ready', data: DEMO_DATA[key] }
      ])));
      setIsLoading(false);
      return () => { cancelled = true; };
    }

    Promise.allSettled(keys.map(key => api[RESOURCES[key].method]()))
      .then(results => {
        if (cancelled) return;
        setResources(Object.fromEntries(Object.keys(RESOURCES).map(key => {
          const index = keys.indexOf(key);
          if (index < 0) return [key, { state: 'unavailable', data: [] }];
          const result = results[index];
          if (result.status === 'rejected') return [key, {
            state: 'error', data: [], error: result.reason?.message || 'No se pudo cargar.'
          }];
          try {
            return [key, { state: 'ready', data: decodeHomeCollection(result.value) }];
          } catch (error) {
            return [key, { state: 'error', data: [], error: error.message }];
          }
        })));
        setLoadedAt(new Date());
      }).finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, [api, dataMode, keys, revision]);

  const summary = useMemo(() => homeSnapshot(resources), [resources]);
  const availableAlerts = keys.filter(key => ['orders', 'scoutingRuns'].includes(key));
  const alertLoadFailed = availableAlerts.some(key => resources[key]?.state === 'error');
  const alertLoadPending = availableAlerts.some(key => resources[key]?.state === 'loading');
  const noResources = keys.length === 0;
  const allFailed = keys.length > 0 && keys.every(key => resources[key]?.state === 'error');
  const open = useCallback((view, id) => onNavigate?.(view, id ? { id } : undefined), [onNavigate]);

  return (
    <div className="page-grid operations-home">
      <header className="operations-home__heading">
        <div>
          <span className="eyebrow">Centro de trabajo</span>
          <h1>Tu operación agronómica</h1>
          <p>Seguimiento y próximos pasos de los registros a los que tenés acceso.</p>
        </div>
        <div className="operations-home__heading-actions">
          <span className={dataMode === 'mock' ? 'operations-home__demo' : 'operations-home__connected'}>
            {dataMode === 'mock' ? 'Datos de demostración' : 'Datos de tu organización'}
          </span>
          <button type="button" className="ghost-action" onClick={() => setRevision(value => value + 1)}
            disabled={isLoading} aria-label="Actualizar centro de trabajo">
            <RefreshCw size={16} aria-hidden="true" /> Actualizar
          </button>
        </div>
      </header>

      {dataMode === 'mock' && (
        <p className="operations-home__notice" role="status">
          Vista de demostración: los ejemplos no representan tareas reales de una empresa.
        </p>
      )}
      {!isLoading && allFailed && (
        <section className="operations-home__failure" role="alert">
          <AlertCircle size={19} aria-hidden="true" />
          <div><strong>No pudimos consultar la operación.</strong>
            <p>Los datos de ejemplo no reemplazan una respuesta del servidor. Probá nuevamente.</p></div>
          <button type="button" className="ghost-action" onClick={() => setRevision(value => value + 1)}>Reintentar</button>
        </section>
      )}
      {!isLoading && !allFailed && summary.failedKeys.length > 0 && (
        <section className="operations-home__notice" role="status">
          Parte de la información no se pudo consultar: {summary.failedKeys.map(key => RESOURCES[key].label).join(', ')}.
          Las cifras no disponibles se muestran con un guion, no como cero.
        </section>
      )}
      {noResources && !isLoading && (
        <section className="operations-home__notice">
          No tenés módulos de seguimiento asignados en esta empresa. Consultá con el administrador.
        </section>
      )}

      <section aria-label="Indicadores de la operación" className="operations-home__metrics">
        {summary.metrics.filter(item => keys.includes(item.key)).map(item => (
          <article className="operations-home__metric" key={item.key}>
            <span>{item.label}</span>
            <strong>{resources[item.key]?.state === 'loading' ? '…' : item.value ?? '—'}
              {item.value !== null && item.unit && <small> {item.unit}</small>}</strong>
            <button type="button" className="operations-home__text-action"
              onClick={() => open(RESOURCES[item.key].view)}>
              Ver {RESOURCES[item.key].label.toLowerCase()} <ArrowRight size={14} aria-hidden="true" />
            </button>
          </article>
        ))}
      </section>

      <div className="operations-home__content">
        <section className="operations-home__priority" aria-labelledby="home-priorities-title">
          <div className="operations-home__section-heading">
            <div>
              <h2 id="home-priorities-title">Requieren atención</h2>
              <p>Órdenes vencidas o prioritarias, aprobaciones y recorridas pendientes.</p>
            </div>
            {summary.alertCount > 0 && <span>{summary.alertCount} registros</span>}
          </div>
          {alertLoadPending ? <p role="status" className="operations-home__placeholder">Consultando prioridades…</p>
            : summary.alerts.length > 0 ? (
              <div className="operations-home__priority-list">
                {summary.alerts.map(item => (
                  <button type="button" key={item.kind + ':' + item.id}
                    className="operations-home__priority-item" onClick={() => open(item.view, item.id)}>
                    <span className={'operations-home__priority-mark operations-home__priority-mark--' +
                      (item.weight < 2 ? 'urgent' : item.weight < 4 ? 'warning' : 'neutral')}>
                      {item.kind === 'order' ? <ClipboardList size={17} aria-hidden="true" /> :
                        <Compass size={17} aria-hidden="true" />}
                    </span>
                    <span className="operations-home__priority-description">
                      <strong>{item.title}</strong><span>{item.context} · {item.reason}</span>
                    </span>
                    <ArrowRight size={17} aria-hidden="true" />
                  </button>
                ))}
              </div>
            ) : alertLoadFailed ? (
              <p role="status" className="operations-home__placeholder">
                No podemos confirmar si hay tareas pendientes: falló una consulta. Reintentá.
              </p>
            ) : availableAlerts.length === 0 ? (
              <p className="operations-home__placeholder">Tu rol no tiene acceso a órdenes ni a recorridas.</p>
            ) : (
              <div className="operations-home__empty"><ShieldAlert size={22} aria-hidden="true" />
                <strong>No hay registros que requieran atención en los datos consultados.</strong>
                <p>Podés revisar las órdenes y recorridas para continuar con la operación.</p>
              </div>
            )}
          {summary.alertCount > summary.alerts.length && (
            <p className="operations-home__more">
              Se muestran las primeras {summary.alerts.length} prioridades. Abrí cada módulo para ver todas.
            </p>
          )}
        </section>
        <aside className="operations-home__shortcuts" aria-labelledby="home-shortcuts-title">
          <div className="operations-home__section-heading">
            <div><h2 id="home-shortcuts-title">Ir a trabajar</h2>
              <p>Accesos a los módulos disponibles.</p></div>
          </div>
          <div className="operations-home__shortcut-list">
            {keys.map(key => {
              const Icon = RESOURCES[key].icon;
              return (
                <button className="operations-home__shortcut" type="button" key={key}
                  onClick={() => open(RESOURCES[key].view)}>
                  <Icon size={19} aria-hidden="true" />
                  <span>{RESOURCES[key].label}</span>
                  <ArrowRight size={16} aria-hidden="true" />
                </button>
              );
            })}
          </div>
          {loadedAt && dataMode === 'live' &&
            <p className="operations-home__updated">Consulta realizada: {loadedAt.toLocaleTimeString('es-AR',
              { hour: '2-digit', minute: '2-digit' })}</p>}
        </aside>
      </div>
    </div>
  );
}
