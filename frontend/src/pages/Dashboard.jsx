import { useEffect, useMemo, useState } from 'react';
import { AreaChart, Calendar, ClipboardCheck, Compass, Eye, ShieldAlert, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { StatTile } from '../components/StatTile.jsx';
import { WorkQueue } from '../components/WorkQueue.jsx';
import { useSession } from '../context/SessionContext.jsx';
import { mockData } from '../services/mockData.js';

function unwrap(response) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.data)) return response.data;
  return [];
}

function dashboardMock() {
  return {
    fields: mockData.fields,
    orders: mockData.workOrders,
    scoutingRuns: mockData.scoutingRuns,
    campaigns: mockData.campaigns,
    source: 'mock'
  };
}

export function Dashboard() {
  const { api, dataMode } = useSession();
  const [data, setData] = useState(() => dashboardMock());

  useEffect(() => {
    let isMounted = true;

    async function load() {
      if (dataMode === 'mock') {
        setData(dashboardMock());
        return;
      }

      try {
        const [fields, orders, scoutingRuns, campaigns] = await Promise.all([
          api.fields(),
          api.workOrders(),
          api.scoutingRuns(),
          api.campaigns()
        ]);

        if (isMounted) {
          setData({
            fields: unwrap(fields),
            orders: unwrap(orders),
            scoutingRuns: unwrap(scoutingRuns),
            campaigns: unwrap(campaigns),
            source: 'live'
          });
        }
      } catch {
        if (isMounted) setData({ ...dashboardMock(), source: 'fallback' });
      }
    }

    load();
    return () => {
      isMounted = false;
    };
  }, [api, dataMode]);

  const stats = useMemo(() => {
    const hectares = data.fields.reduce((total, field) => total + Number(field.area_hectares || 0), 0);
    const openOrders = data.orders.filter((order) => !['completed', 'cancelled'].includes(order.status)).length;
    const urgentOrders = data.orders.filter((order) => ['high', 'urgent'].includes(order.priority)).length;
    const activeCampaigns = data.campaigns.filter((campaign) => campaign.status === 'active').length;

    return {
      hectares,
      openOrders,
      urgentOrders,
      activeCampaigns,
      scoutingRuns: data.scoutingRuns.length
    };
  }, [data]);

  const queue = data.orders.slice(0, 4).map((order) => ({
    title: order.title,
    field: order.Field?.name || order.field_id || 'Sin lote',
    status: order.status
  }));

  return (
    <div className="page-grid">
      <section className="page-heading">
        <span className="eyebrow">Operación agronómica</span>
        <h1>Panel de campaña</h1>
        <span className={`source-chip source-chip--${data.source}`}>{data.source === 'live' ? 'Backend' : data.source === 'fallback' ? 'Mock fallback' : 'Mock'}</span>
      </section>
      
      <div className="stats-row">
        <StatTile label="Hectáreas activas" value={stats.hectares.toLocaleString('es-AR')} tone="green" icon={AreaChart} />
        <StatTile label="Campañas activas" value={stats.activeCampaigns} tone="amber" icon={Calendar} />
        <StatTile label="Monitoreos" value={stats.scoutingRuns} tone="blue" icon={Compass} />
        <StatTile label="OT abiertas" value={stats.openOrders} tone="rose" icon={ClipboardCheck} />
      </div>
      
      <section className="map-panel">
        <div className="map-panel__canvas">
          {/* Stylized vector contour polygons simulating satellite land lots */}
          <svg className="map-panel__vector-bg" viewBox="0 0 500 300" preserveAspectRatio="none">
            <defs>
              <linearGradient id="grad-green" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="rgba(16, 185, 129, 0.25)" />
                <stop offset="100%" stopColor="rgba(52, 211, 153, 0.05)" />
              </linearGradient>
              <linearGradient id="grad-amber" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="rgba(245, 158, 11, 0.25)" />
                <stop offset="100%" stopColor="rgba(251, 191, 36, 0.05)" />
              </linearGradient>
              <linearGradient id="grad-rose" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="rgba(244, 63, 94, 0.25)" />
                <stop offset="100%" stopColor="rgba(251, 113, 133, 0.05)" />
              </linearGradient>
            </defs>
            {/* Grid pattern lines */}
            <path d="M 0,50 L 500,50 M 0,100 L 500,100 M 0,150 L 500,150 M 0,200 L 500,200 M 0,250 L 500,250" stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
            <path d="M 100,0 L 100,300 M 200,0 L 200,300 M 300,0 L 300,300 M 400,0 L 400,300" stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
            
            {/* Field Lot polygons */}
            <polygon points="50,40 180,30 160,110 40,120" fill="url(#grad-green)" stroke="rgba(16, 185, 129, 0.4)" strokeWidth="1.5" />
            <polygon points="280,60 440,70 410,160 290,140" fill="url(#grad-amber)" stroke="rgba(245, 158, 11, 0.4)" strokeWidth="1.5" />
            <polygon points="120,160 260,150 240,240 110,250" fill="url(#grad-rose)" stroke="rgba(244, 63, 94, 0.4)" strokeWidth="1.5" />
          </svg>
          
          {data.fields.slice(0, 3).map((field, index) => (
            <span className={`lot lot--${['one', 'two', 'three'][index]}`} key={field.id || field.name}>
              <span className="lot__index">LOTE {index + 1}</span>
              <span className="lot__name">{field.name}</span>
            </span>
          ))}
        </div>
        <div className="map-panel__aside">
          <h2>Semáforo de lotes</h2>
          <p>Priorización en tiempo real por severidad, campaña y órdenes.</p>
          <ul className="semaforo-list">
            <li className="semaforo-item semaforo-item--critical">
              <ShieldAlert size={16} />
              <span><strong>{stats.urgentOrders}</strong> Críticos</span>
            </li>
            <li className="semaforo-item semaforo-item--warning">
              <AlertTriangle size={16} />
              <span><strong>{stats.openOrders}</strong> En seguimiento</span>
            </li>
            <li className="semaforo-item semaforo-item--ok">
              <CheckCircle2 size={16} />
              <span><strong>{Math.max(data.fields.length - stats.urgentOrders, 0)}</strong> Sin alertas</span>
            </li>
          </ul>
        </div>
      </section>
      <WorkQueue items={queue} />
    </div>
  );
}
