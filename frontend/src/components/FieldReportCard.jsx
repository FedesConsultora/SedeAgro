import { useState } from 'react';
import { Activity, AlertCircle, CheckCircle, ClipboardList, MapPin, Sprout } from 'lucide-react';
import { useSession } from '../context/SessionContext.jsx';

const STATUS_ES = {
  planned: 'Planificado', active: 'Activo', closed: 'Cerrado',
  completed: 'Completado', in_progress: 'En curso', archived: 'Archivado'
};

export function FieldReportCard({ fieldId, fieldName, farmName, areaHectares }) {
  const { api, dataMode } = useSession();
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const load = async () => {
    if (loading || report) { setExpanded((v) => !v); return; }
    setLoading(true);
    setExpanded(true);
    try {
      if (dataMode === 'mock') {
        // Mock report data
        setReport({
          field: { name: fieldName, Farm: { name: farmName } },
          activeCampaignField: {
            Campaign: { name: 'Campaña gruesa 2026/27', status: 'active' },
            CropType: { name: 'Soja' },
            status: 'active'
          },
          lastScoutingRun: { scheduled_at: '2026-06-20', status: 'planned', ScoutingObservations: [{ severity: 'medium', observation_type: 'weed' }] },
          workOrdersSummary: { open: 1, closed: 0, recent: [] }
        });
        return;
      }
      const res = await api.getFieldReport(fieldId);
      setReport(res.data);
    } catch {
      setReport(null);
      setExpanded(false);
    } finally {
      setLoading(false);
    }
  };

  const hasCritical = report?.lastScoutingRun?.ScoutingObservations?.some((o) => o.severity === 'critical');
  const openOrders = report?.workOrdersSummary?.open || 0;

  return (
    <div className="report-card">
      {/* Card header — always visible */}
      <div className="report-card__header">
        <div>
          <h3>{fieldName}</h3>
          <span>{farmName} · {Number(areaHectares || 0).toLocaleString('es-AR')} ha</span>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {hasCritical && (
            <span className="status-badge status-badge--rose"><AlertCircle size={12} /> Alerta</span>
          )}
          {openOrders > 0 && (
            <span className="status-badge status-badge--amber">{openOrders} OT abiertas</span>
          )}
          <button type="button" className="ghost-action" style={{ minHeight: 32, padding: '0 12px', fontSize: 12 }}
            onClick={load} disabled={loading}>
            {loading ? 'Cargando…' : expanded ? 'Ocultar' : 'Ver reporte'}
          </button>
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && report && (
        <>
          {/* KPI row */}
          <div className="report-card__kpis">
            <div className={`report-kpi ${openOrders > 0 ? 'report-kpi--amber' : 'report-kpi--green'}`}>
              <span className="report-kpi__label">OTs abiertas</span>
              <span className="report-kpi__value">{report.workOrdersSummary?.open ?? '–'}</span>
            </div>
            <div className="report-kpi report-kpi--green">
              <span className="report-kpi__label">OTs cerradas</span>
              <span className="report-kpi__value">{report.workOrdersSummary?.closed ?? '–'}</span>
            </div>
            <div className={`report-kpi ${hasCritical ? 'report-kpi--rose' : 'report-kpi--green'}`}>
              <span className="report-kpi__label">Observaciones</span>
              <span className="report-kpi__value">
                {report.lastScoutingRun?.ScoutingObservations?.length ?? '–'}
              </span>
            </div>
          </div>

          {/* Campaign info */}
          {report.activeCampaignField && (
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#334155' }}>
                <Sprout size={14} style={{ color: '#059669' }} />
                <strong>{report.activeCampaignField.Campaign?.name}</strong>
                <span className={`status-badge status-badge--${report.activeCampaignField.status}`}>
                  {STATUS_ES[report.activeCampaignField.status] || report.activeCampaignField.status}
                </span>
              </div>
              {report.activeCampaignField.CropType && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#334155' }}>
                  <span style={{ color: '#64748b' }}>Cultivo:</span>
                  <strong>{report.activeCampaignField.CropType.name}</strong>
                </div>
              )}
            </div>
          )}

          {/* Last scouting run */}
          {report.lastScoutingRun ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#334155', background: 'rgba(0,0,0,0.02)', padding: '10px 14px', borderRadius: 8 }}>
              <Activity size={14} style={{ color: '#059669' }} />
              <span>Último monitoreo:</span>
              <strong>{new Date(report.lastScoutingRun.scheduled_at).toLocaleDateString('es-AR')}</strong>
              <span className={`status-badge status-badge--${report.lastScoutingRun.status}`}>
                {STATUS_ES[report.lastScoutingRun.status] || report.lastScoutingRun.status}
              </span>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#94a3b8' }}>
              <Activity size={14} /> Sin recorridas de monitoreo registradas
            </div>
          )}

          {/* Recent work orders */}
          {report.workOrdersSummary?.recent?.length > 0 && (
            <div>
              <p style={{ margin: '0 0 8px', fontSize: 12, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Órdenes recientes
              </p>
              {report.workOrdersSummary.recent.map((wo) => (
                <div key={wo.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: '1px solid rgba(0,0,0,0.04)' }}>
                  <ClipboardList size={13} style={{ color: '#94a3b8', flexShrink: 0 }} />
                  <span style={{ flex: 1, fontSize: 13, color: '#334155' }}>{wo.title}</span>
                  <span className={`status-badge status-badge--${wo.status}`}>{STATUS_ES[wo.status] || wo.status}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
