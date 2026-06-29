import { useEffect, useState } from 'react';
import { Activity, ChevronRight, Plus } from 'lucide-react';
import { useSession } from '../context/SessionContext.jsx';
import { mockData } from '../services/mockData.js';
import { ScoutingRunFormModal } from '../components/ScoutingRunFormModal.jsx';
import { ObservationFormModal } from '../components/ObservationFormModal.jsx';
import { EvidenceUploadModal } from '../components/EvidenceUploadModal.jsx';

const RUN_STATUS_ES = { planned: 'Planificado', in_progress: 'En curso', completed: 'Completado', cancelled: 'Cancelado' };
const SEV_ES = { low: 'Leve', medium: 'Moderado', high: 'Alto', critical: 'Crítico' };
const OBS_TYPE_ES = { weed: 'Maleza', pest: 'Plaga', disease: 'Enfermedad', phenology: 'Fenología', nutrition: 'Nutrición', water: 'Agua', general: 'General' };
const STATUS_FILTER = ['Todos', 'planned', 'in_progress', 'completed'];

function StatusBadge({ status }) {
  return <span className={`status-badge status-badge--${status}`}>{RUN_STATUS_ES[status] || status}</span>;
}

function RunDetail({ run, onObsCreated }) {
  const [showObsModal, setShowObsModal] = useState(false);
  const [showEvidModal, setShowEvidModal] = useState(null); // observationId
  const observations = mockData.scoutingObservations.filter((o) => o.scouting_run_id === run.id);

  return (
    <div style={{ padding: '16px 24px', borderTop: '1px solid rgba(0,0,0,0.04)', animation: 'slideDown 0.2s ease-out' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Observaciones ({observations.length})
        </span>
        <button type="button" className="ghost-action" style={{ minHeight: 30, padding: '0 10px', fontSize: 12 }}
          onClick={() => setShowObsModal(true)}>
          <Plus size={13} /> Agregar observación
        </button>
      </div>
      {observations.length === 0 ? (
        <p style={{ color: '#94a3b8', fontSize: 13, margin: 0 }}>Sin observaciones registradas</p>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          {observations.map((obs) => (
            <div key={obs.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderBottom: '1px solid rgba(0,0,0,0.04)' }}>
              <span className={`status-badge status-badge--${obs.severity === 'critical' ? 'rose' : obs.severity === 'high' ? 'amber' : 'green'}`}>
                {SEV_ES[obs.severity] || obs.severity}
              </span>
              <span style={{ flex: 1, fontSize: 13, color: '#334155' }}>
                <strong style={{ marginRight: 4 }}>{OBS_TYPE_ES[obs.observation_type] || obs.observation_type}</strong>
                {obs.notes}
              </span>
              <button type="button" className="ghost-action" style={{ minHeight: 28, padding: '0 8px', fontSize: 11 }}
                onClick={() => setShowEvidModal(obs.id)}>
                + Evidencia
              </button>
            </div>
          ))}
        </div>
      )}
      {showObsModal && (
        <ObservationFormModal isOpen runId={run.id} onClose={() => setShowObsModal(false)} onCreated={() => { setShowObsModal(false); onObsCreated?.(); }} />
      )}
      {showEvidModal && (
        <EvidenceUploadModal isOpen observationId={showEvidModal} onClose={() => setShowEvidModal(null)} onCreated={() => setShowEvidModal(null)} />
      )}
    </div>
  );
}

export function ScoutingPage() {
  const { api, dataMode } = useSession();
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('Todos');
  const [expanded, setExpanded] = useState({});
  const [showModal, setShowModal] = useState(false);

  const load = async () => {
    setLoading(true);
    if (dataMode === 'mock') { setRuns(mockData.scoutingRuns); setLoading(false); return; }
    try {
      const res = await api.scoutingRuns();
      setRuns(res.data || []);
    } catch {
      setRuns(mockData.scoutingRuns);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [api, dataMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = filter === 'Todos' ? runs : runs.filter((r) => r.status === filter);
  const toggleExpand = (id) => setExpanded((e) => ({ ...e, [id]: !e[id] }));

  return (
    <div className="page-grid">
      <section className="page-heading">
        <div>
          <span className="eyebrow">Control de cultivos</span>
          <h1>Monitoreo</h1>
        </div>
        <button type="button" className="primary-action" onClick={() => setShowModal(true)}>
          <Plus size={16} /> Nueva recorrida
        </button>
      </section>

      <div className="page-toolbar">
        <div className="filter-bar">
          {STATUS_FILTER.map((s) => (
            <button key={s} type="button"
              className={`filter-chip ${filter === s ? 'filter-chip--active' : ''}`}
              onClick={() => setFilter(s)}>
              {s === 'Todos' ? 'Todos' : RUN_STATUS_ES[s] || s}
            </button>
          ))}
        </div>
        <span style={{ fontSize: 13, color: '#64748b' }}>{visible.length} recorridas</span>
      </div>

      {/* Table */}
      <div className="data-table-wrapper">
        <div className="data-table">
          {/* Header */}
          <div className="data-table__row data-table__row--head" style={{ gridTemplateColumns: '2fr 1fr 1fr 1fr 40px' }}>
            <span>Lote / Campaña</span>
            <span>Fecha planificada</span>
            <span>Estado</span>
            <span>Asignado a</span>
            <span />
          </div>

          {loading ? (
            <div style={{ padding: '24px', color: '#94a3b8', fontSize: 13 }}>Cargando…</div>
          ) : visible.length === 0 ? (
            <div className="empty-state">
              <Activity size={36} />
              <h3>Sin recorridas</h3>
              <p>Creá tu primera recorrida de monitoreo.</p>
            </div>
          ) : (
            visible.map((run) => (
              <div key={run.id}>
                <div
                  className="data-table__row"
                  style={{ gridTemplateColumns: '2fr 1fr 1fr 1fr 40px', cursor: 'pointer' }}
                  onClick={() => toggleExpand(run.id)}
                >
                  <span>
                    <strong>{run.CampaignField?.Field?.name || 'Lote'}</strong>
                    {run.CampaignField?.CropType?.name && <> · {run.CampaignField.CropType.name}</>}
                  </span>
                  <span>{run.scheduled_at ? new Date(run.scheduled_at).toLocaleDateString('es-AR') : '–'}</span>
                  <span><StatusBadge status={run.status} /></span>
                  <span>{run.assigned_to || 'Sin asignar'}</span>
                  <ChevronRight size={16} style={{ color: '#94a3b8', transform: expanded[run.id] ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }} />
                </div>
                {expanded[run.id] && <RunDetail run={run} onObsCreated={load} />}
              </div>
            ))
          )}
        </div>
      </div>

      {showModal && (
        <ScoutingRunFormModal isOpen onClose={() => setShowModal(false)} onCreated={() => { setShowModal(false); load(); }} />
      )}
    </div>
  );
}
