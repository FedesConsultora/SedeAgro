import { useId, useState } from 'react';
import { ChevronDown, ChevronRight, Plus, Sprout } from 'lucide-react';
import { useSession } from '../context/SessionContext.jsx';
import { mockData } from '../services/mockData.js';
import { CampaignFormModal } from '../components/CampaignFormModal.jsx';
import { AssignFieldModal } from '../components/AssignFieldModal.jsx';
import { ResourceLoadNotice } from '../components/ResourceLoadNotice.jsx';
import { useTenantCollection } from '../services/useTenantCollection.js';
import { WorkspaceHeading, CollectionState } from '../components/WorkspacePrimitives.jsx';

const STATUS_ES = { planned: 'Planificado', active: 'Activo', closed: 'Cerrado', archived: 'Archivado' };
const STATUS_FILTER = ['Todos', 'active', 'planned', 'closed'];

function StatusBadge({ status }) {
  return <span className={`status-badge status-badge--${status}`}>{STATUS_ES[status] || status}</span>;
}

function CampaignCard({ campaign, onUpdated, canEdit }) {
  const [expanded, setExpanded] = useState(false);
  const regionId = useId();
  const [showAssignModal, setShowAssignModal] = useState(false);
  const fields = campaign.CampaignFields || [];

  const fmt = (d) => d ? new Date(d).toLocaleDateString('es-AR') : '–';

  return (
    <div className="farm-card">
      <div className="farm-card__header">
        <button type="button" className="farm-card__toggle"
          onClick={() => setExpanded(value => !value)} aria-expanded={expanded}
          aria-controls={regionId} aria-label={`Campaña ${campaign.name}, ${expanded ? 'ocultar' : 'mostrar'} lotes`}>
          <span className="farm-card__meta">
            <span className="farm-card__icon" style={{ background: 'rgba(245,158,11,0.08)', color: '#b45309' }}>
              <Sprout size={22} aria-hidden="true" />
            </span>
            <span className="farm-card__info">
              <strong>{campaign.name}</strong>
              <span>{campaign.season_year} · {fmt(campaign.starts_at)} → {fmt(campaign.ends_at)}</span>
            </span>
          </span>
          <span className="farm-card__stats">
            <span className="stat"><strong>{fields.length}</strong><span>{fields.length === 1 ? 'lote' : 'lotes'}</span></span>
          </span>
          {expanded ? <ChevronDown size={18} aria-hidden="true" /> :
            <ChevronRight size={18} aria-hidden="true" />}
        </button>
        <div className="farm-card__actions">
          <StatusBadge status={campaign.status} />
          {canEdit && <button type="button" className="ghost-action" onClick={() => setShowAssignModal(true)}>
            <Plus size={14} aria-hidden="true" /> Asignar lote
          </button>}
        </div>
      </div>

      {expanded && (
        <div id={regionId} className="farm-card__fields">
          {fields.length === 0 ? (
            <div style={{ padding: '16px 24px', color: '#94a3b8', fontSize: 13 }}>Sin lotes asignados</div>
          ) : (
            fields.map((cf) => (
              <div key={cf.id} className="field-row">
                <span className="field-row__name">
                  {cf.Field?.name || 'Lote desconocido'}
                </span>
                <span style={{ fontSize: 12, color: '#64748b' }}>
                  {cf.CropType?.name || '–'}
                </span>
                <StatusBadge status={cf.status} />
                {cf.planting_date && (
                  <span className="field-row__ha" style={{ fontSize: 12 }}>
                    Siembra: {new Date(cf.planting_date).toLocaleDateString('es-AR')}
                  </span>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {canEdit && showAssignModal && (
        <AssignFieldModal
          isOpen
          campaignId={campaign.id}
          campaignName={campaign.name}
          onClose={() => setShowAssignModal(false)}
          onCreated={() => { setShowAssignModal(false); onUpdated(); }}
        />
      )}
    </div>
  );
}

export function CampaignsPage() {
  const { api, dataMode, session } = useSession();
  const canEdit = dataMode === 'live' &&
    ['tenant_admin', 'agronomic_coordinator'].includes(session?.membership?.roleCode);
  const { records: campaigns, loading, error, reload } = useTenantCollection({
    api, method: 'campaigns', dataMode, tenantId: session?.tenant?.id,
    mockRecords: mockData.campaigns, title: 'campañas'
  });
  const [filter, setFilter] = useState('Todos');
  const [showModal, setShowModal] = useState(false);

  const visible = filter === 'Todos' ? campaigns : campaigns.filter((c) => c.status === filter);

  return (
    <div className="page-grid">
      <WorkspaceHeading eyebrow="Planificación temporal" title="Campañas"
        actions={canEdit && <button type="button" className="primary-action"
          onClick={() => setShowModal(true)}>
          <Plus size={16} /> Nueva campaña
        </button>} />

      <div className="page-toolbar">
        <div className="filter-bar">
          {STATUS_FILTER.map((s) => (
            <button key={s} type="button"
              className={`filter-chip ${filter === s ? 'filter-chip--active' : ''}`}
              aria-pressed={filter === s}
              onClick={() => setFilter(s)}>
              {s === 'Todos' ? 'Todos' : STATUS_ES[s] || s}
            </button>
          ))}
        </div>
        <span role="status" className="workspace-results-count">{loading || error ? '—' : visible.length} campañas</span>
      </div>

      {error && <ResourceLoadNotice title="campañas" error={error} onRetry={reload} />}
      {dataMode === 'mock' && <p className="resource-demo-note" role="status">Campañas de demostración.</p>}
      {error ? null : loading ? (
        <CollectionState status="loading" />
      ) : visible.length === 0 ? (
        <CollectionState status={filter === 'Todos' ? 'empty' : 'filtered'} icon={Sprout}
          title={filter === 'Todos' ? 'Sin campañas' : 'Sin campañas con ese estado'}
          description={filter === 'Todos'
            ? 'Todavía no hay campañas registradas para esta empresa.'
            : 'Probá otro estado o seleccioná Todos para revisar el historial.'}
          action={filter !== 'Todos'
            ? <button type="button" className="ghost-action" onClick={() => setFilter('Todos')}>Ver todas</button>
            : canEdit && <button type="button" className="primary-action" onClick={() => setShowModal(true)}>
                <Plus size={16} /> Nueva campaña
              </button>} />
      ) : (
        <div style={{ display: 'grid', gap: 16 }}>
          {visible.map((c) => <CampaignCard key={c.id} campaign={c} canEdit={canEdit} onUpdated={reload} />)}
        </div>
      )}

      {canEdit && showModal && (
        <CampaignFormModal isOpen onClose={() => setShowModal(false)} onCreated={() => { setShowModal(false); reload(); }} />
      )}
    </div>
  );
}
