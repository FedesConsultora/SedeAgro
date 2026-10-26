import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ClipboardList, Plus, RefreshCw, Search } from 'lucide-react';
import { useSession } from '../context/SessionContext.jsx';
import { mockData } from '../services/mockData.js';
import { countWorkOrderFilters, filterWorkOrders } from '../services/workOrderFilters.js';
import {
  workOrderPrivateListScope, checkedWorkOrderPrivateRows,
  visibleWorkOrderPrivateSnapshot, visibleWorkOrderPrivateSelection
} from '../services/workOrderPrivateListScope.js';
import { WorkOrderFormModal } from '../components/WorkOrderFormModal.jsx';
import { WorkOrderDetailDrawer } from '../components/WorkOrderDetailDrawer.jsx';
import { WorkOrderReviewInbox } from '../components/WorkOrderReviewInbox.jsx';
import './work-orders-workspace.css';

const STATUS_ES = {
  draft: 'Borrador', pending_approval: 'Pend. aprobación', approved: 'Aprobado',
  assigned: 'Asignado', in_progress: 'En curso', completed: 'Completado', cancelled: 'Cancelado'
};
const PRIORITY_ES = { low: 'Baja', normal: 'Normal', high: 'Alta', urgent: 'Urgente' };
const TYPE_ES = {
  application: 'Aplicación', sowing: 'Siembra', fertilization: 'Fertilización',
  harvest: 'Cosecha', irrigation: 'Riego', inspection: 'Inspección', other: 'Otro'
};
const PRIORITY_COLOR = { low: 'gray', normal: 'blue', high: 'amber', urgent: 'rose' };
const FILTERS = [
  { value: 'all', label: 'Todas' }, { value: 'attention', label: 'Requieren atención' },
  { value: 'assigned', label: 'Asignadas' }, { value: 'in_progress', label: 'En curso' },
  { value: 'pending_approval', label: 'Por aprobar' }, { value: 'completed', label: 'Completadas' }
];

export function WorkOrdersPage({ focusOrderId = null }) {
  const { api, dataMode, session } = useSession();
  const scope = workOrderPrivateListScope(session, dataMode);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const apiRef = useRef(api);
  apiRef.current = api;
  const canCreate = dataMode === 'live' && Boolean(scope) &&
    ['tenant_admin', 'agronomic_coordinator'].includes(session?.membership?.roleCode);
  const [snapshot, setSnapshot] = useState(null);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [selectedSnapshot, setSelectedSnapshot] = useState(null);
  const [focusState, setFocusState] = useState(null);
  const [revision, setRevision] = useState(0);
  const revisionRef = useRef(revision);
  revisionRef.current = revision;

  // A changed actor/tenant/role/API hides the previous private data during
  // the FIRST render, before useEffect can clear or refetch anything.
  const scoped = visibleWorkOrderPrivateSnapshot(snapshot, scope, api, revision);
  const orders = scoped?.rows || [];
  const loading = Boolean(scope && (!scoped || scoped.phase === 'loading'));
  const error = dataMode === 'live' && !scope
    ? 'No se pudo validar el acceso a órdenes para esta sesión.'
    : scoped?.error || '';
  const selectedOrder = visibleWorkOrderPrivateSelection(selectedSnapshot, scope, api, revision);
  const focusError = focusState?.scope === scope && focusState?.api === api &&
    focusState?.revision === revision ? focusState.error : '';
  const selectOrder = (order) => setSelectedSnapshot({ scope, api, revision, order });

  const reload = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    let cancelled = false;
    const current = () => !cancelled && scopeRef.current === scope && apiRef.current === api &&
      revisionRef.current === revision;
    setSnapshot({ scope, api, revision, rows: [], phase: 'loading', error: '' });
    setSelectedSnapshot(null);
    if (!scope) return () => { cancelled = true; };
    if (dataMode === 'mock') {
      setSnapshot({ scope, api, revision, rows: mockData.workOrders, phase: 'ready', error: '' });
      return () => { cancelled = true; };
    }
    api.workOrders().then(response => {
      const rows = checkedWorkOrderPrivateRows(response.data, session.tenant.id);
      if (current()) setSnapshot({ scope, api, revision, rows, phase: 'ready', error: '' });
    }).catch(err => {
      if (current()) setSnapshot({
        scope, api, revision, rows: [], phase: 'error',
        error: err?.message || 'No se pudo consultar el servidor de órdenes.'
      });
    });
    return () => { cancelled = true; };
  }, [scope, api, dataMode, revision]);

  useEffect(() => {
    setFocusState({ scope, api, revision, error: '' });
    if (!focusOrderId || !scope || !scoped || scoped.phase !== 'ready' || error) return;
    const matching = orders.find(item => item.id === focusOrderId);
    if (matching) {
      selectOrder(matching);
      setFilter('all');
      setSearch('');
    } else {
      setFocusState({ scope, api, revision,
        error: 'La orden solicitada no está disponible en esta cuenta o empresa.' });
    }
  }, [focusOrderId, scoped, scope, api, revision, error]);

  const visible = useMemo(() => filterWorkOrders(orders, { filter, search }), [orders, filter, search]);
  const counts = useMemo(() => countWorkOrderFilters(orders), [orders]);

  return (
    <div className="page-grid orders-workspace">
      <header className="page-heading">
        <div>
          <span className="eyebrow">Operación de campo</span>
          <h1>Órdenes de trabajo</h1>
          <p className="orders-workspace__description">
            Encontrá lo pendiente, revisá responsabilidades y abrí cada orden.
          </p>
        </div>
        <div className="orders-workspace__heading-actions">
          <button type="button" className="ghost-action" onClick={reload} disabled={loading}>
            <RefreshCw size={16} aria-hidden="true" /> Actualizar
          </button>
          {canCreate && (
            <button type="button" className="primary-action" onClick={() => setShowModal(true)}>
              <Plus size={16} aria-hidden="true" /> Nueva orden
            </button>
          )}
        </div>
      </header>

      {dataMode === 'mock' && <p className="orders-workspace__demo" role="status">
        Demostración: las órdenes mostradas son ejemplos y no se guardan en el servidor.
      </p>}
      {error && (
        <section className="orders-workspace__error" role="alert">
          <AlertCircle size={19} aria-hidden="true" />
          <div><strong>No se pudieron cargar las órdenes reales.</strong><p>{error}</p></div>
          <button type="button" className="ghost-action" onClick={reload}>Reintentar</button>
        </section>
      )}
      {focusError && !error && <p className="orders-workspace__error" role="status">{focusError}</p>}
      {scope && <WorkOrderReviewInbox key={scope} revision={revision} onOpenOrder={selectOrder} />}

      {!error && (
        <>
          <div className="orders-workspace__toolbar">
            <div className="filter-bar" role="group" aria-label="Filtrar órdenes por estado">
              {FILTERS.map(item => (
                <button key={item.value} type="button"
                  aria-pressed={filter === item.value}
                  className={'filter-chip ' + (filter === item.value ? 'filter-chip--active' : '')}
                  onClick={() => setFilter(item.value)}>
                  {item.label} <span className="orders-workspace__filter-count">
                    {loading ? '…' : counts[item.value]}
                  </span>
                </button>
              ))}
            </div>
            <label className="orders-workspace__search">
              <Search size={17} aria-hidden="true" />
              <span className="sr-only">Buscar por título, lote, tipo o instrucciones</span>
              <input type="search" placeholder="Buscar orden o lote" value={search}
                onChange={event => setSearch(event.target.value)} />
            </label>
          </div>
          <p className="orders-workspace__result-count" role="status">
            {loading ? 'Consultando órdenes…' :
              `${visible.length} de ${orders.length} órdenes visibles`}
          </p>

          <div className="data-table-wrapper">
            <div className="data-table">
              <div className="data-table__row data-table__row--head orders-workspace__row">
                <span>Orden</span><span>Lote</span><span>Prioridad</span>
                <span>Estado</span><span>Vencimiento</span>
              </div>
              {loading ? (
                <p className="orders-workspace__empty" role="status">Cargando órdenes desde el servidor…</p>
              ) : visible.length === 0 ? (
                <div className="orders-workspace__empty">
                  <ClipboardList size={28} aria-hidden="true" />
                  <h2>{orders.length === 0 ? 'Todavía no hay órdenes' : 'No hay coincidencias'}</h2>
                  <p>{orders.length === 0
                    ? 'Cuando haya órdenes registradas, aparecerán en esta lista.'
                    : 'Probá otra búsqueda o cambiá el filtro.'}</p>
                  {orders.length > 0 && (
                    <button type="button" className="ghost-action"
                      onClick={() => { setFilter('all'); setSearch(''); }}>Limpiar filtros</button>
                  )}
                </div>
              ) : visible.map(order => (
                <button key={order.id} type="button"
                  className="data-table__row orders-workspace__row orders-workspace__order"
                  onClick={() => selectOrder(order)} aria-label={'Abrir orden: ' + order.title}>
                  <strong>{order.title}</strong>
                  <span>{order.Field?.name || 'Lote no especificado'}</span>
                  <span><span className={'status-badge status-badge--' +
                    (PRIORITY_COLOR[order.priority] || 'gray')}>
                    {PRIORITY_ES[order.priority] || order.priority}
                  </span></span>
                  <span><span className={'status-badge status-badge--' + order.status}>
                    {STATUS_ES[order.status] || order.status}
                  </span></span>
                  <span>{order.due_at
                    ? new Date(order.due_at).toLocaleDateString('es-AR') : 'Sin fecha'}</span>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
      {showModal && scope && <WorkOrderFormModal isOpen
        onClose={() => setShowModal(false)}
        onCreated={() => { setShowModal(false); reload(); }} />}
      {selectedOrder && <WorkOrderDetailDrawer key={`${scope}:${selectedOrder.id}`} isOpen
        order={selectedOrder} onClose={() => setSelectedSnapshot(null)}
        onUpdated={() => { setSelectedSnapshot(null); reload(); }} />}
    </div>
  );
}
