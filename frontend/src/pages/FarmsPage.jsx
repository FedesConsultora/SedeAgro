import { Fragment, useState } from 'react';
import { ChevronDown, ChevronRight, MapPin, Plus, Landmark } from 'lucide-react';
import { useSession } from '../context/SessionContext.jsx';
import { mockData } from '../services/mockData.js';
import { FarmFormModal } from '../components/FarmFormModal.jsx';
import { FieldFormModal } from '../components/FieldFormModal.jsx';
import { FieldGeographyPanel } from '../components/FieldGeographyPanel.jsx';
import { ResourceLoadNotice } from '../components/ResourceLoadNotice.jsx';
import { useTenantCollection } from '../services/useTenantCollection.js';
import { WorkspaceHeading, CollectionState } from '../components/WorkspacePrimitives.jsx';

const STATUS_ES = { active: 'Activo', inactive: 'Inactivo', archived: 'Archivado' };

function StatusBadge({ status }) {
  return <span className={`status-badge status-badge--${status}`}>{STATUS_ES[status] || status}</span>;
}

function FarmCard({ farm, onFieldAdded, canEdit }) {
  const [expanded, setExpanded] = useState(false);
  const [showFieldModal, setShowFieldModal] = useState(false);
  const [focusedFieldId, setFocusedFieldId] = useState(null);
  const fields = farm.Fields || [];
  const totalHa = fields.reduce((s, f) => s + Number(f.area_hectares || 0), 0);

  return (
    <div className="farm-card">
      {/* Farm Header */}
      <div className="farm-card__header" onClick={() => setExpanded((v) => !v)} role="button" tabIndex={0}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget || !['Enter', ' '].includes(e.key)) return;
          e.preventDefault();
          setExpanded((value) => !value);
        }}
        aria-expanded={expanded}
        aria-label={`Establecimiento ${farm.name}, ${expanded ? 'ocultar' : 'mostrar'} lotes`}>
        <div className="farm-card__meta">
          <div className="farm-card__icon"><Landmark size={22} /></div>
          <div className="farm-card__info">
            <strong>{farm.name}</strong>
            <span>
              {[farm.locality, farm.province, farm.country].filter(Boolean).join(' · ')}
              {farm.Producer ? ` · ${farm.Producer.name}` : ''}
            </span>
          </div>
        </div>

        <div className="farm-card__stats">
          <div className="stat">
            <strong>{totalHa.toLocaleString('es-AR')}</strong>
            <span>ha declaradas</span>
          </div>
          <div className="stat">
            <strong>{fields.length}</strong>
            <span>{fields.length === 1 ? 'lote' : 'lotes'}</span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {canEdit && <button
            type="button"
            className="ghost-action"
            style={{ minHeight: 34, padding: '0 12px', fontSize: 12 }}
            onClick={(e) => { e.stopPropagation(); setShowFieldModal(true); }}
          >
            <Plus size={14} /> Nuevo lote
          </button>}
          {expanded ? <ChevronDown size={18} style={{ color: '#64748b', flexShrink: 0 }} /> : <ChevronRight size={18} style={{ color: '#64748b', flexShrink: 0 }} />}
        </div>
      </div>

      {/* Field List */}
      {expanded && (
        <div className="farm-card__fields">
          {fields.length === 0 ? (
            <div style={{ padding: '16px 24px', color: '#94a3b8', fontSize: 13 }}>
              Sin lotes registrados
            </div>
          ) : (
            fields.map((field) => (
              <Fragment key={field.id}>
                <button type="button"
                  className="field-row field-row--selectable"
                  aria-expanded={focusedFieldId === field.id}
                  aria-label={`Ver contexto geográfico del lote ${field.name}`}
                  onClick={() => setFocusedFieldId(current => current === field.id ? null : field.id)}>
                  <MapPin size={14} style={{ color: '#6b8e74', flexShrink: 0 }} />
                  <span className="field-row__name">{field.name}</span>
                  <StatusBadge status={field.status} />
                  <span className="field-row__ha">
                    {field.area_hectares == null ? 'Sin superficie declarada' :
                      `${Number(field.area_hectares).toLocaleString('es-AR')} ha`}
                  </span>
                  <ChevronRight size={15} aria-hidden="true"
                    style={{ transform: focusedFieldId === field.id ? 'rotate(90deg)' : undefined }} />
                </button>
                {focusedFieldId === field.id && (
                  <FieldGeographyPanel
                    field={field}
                    farm={farm}
                    onClose={() => setFocusedFieldId(null)}
                  />
                )}
              </Fragment>
            ))
          )}
        </div>
      )}

      {canEdit && showFieldModal && (
        <FieldFormModal
          isOpen
          farmId={farm.id}
          farmName={farm.name}
          onClose={() => setShowFieldModal(false)}
          onCreated={() => { setShowFieldModal(false); onFieldAdded(); }}
        />
      )}
    </div>
  );
}

export function FarmsPage() {
  const { api, dataMode, session } = useSession();
  const canEdit = dataMode === 'live' &&
    ['tenant_admin', 'agronomic_coordinator'].includes(session?.membership?.roleCode);
  const { records: farms, loading, error, reload } = useTenantCollection({
    api, method: 'farms', dataMode, tenantId: session?.tenant?.id,
    mockRecords: mockData.farms, title: 'establecimientos'
  });
  const [showFarmModal, setShowFarmModal] = useState(false);

  return (
    <div className="page-grid">
      <WorkspaceHeading eyebrow="Gestión territorial" title="Establecimientos y lotes"
        actions={canEdit && <button type="button" className="primary-action" onClick={() => setShowFarmModal(true)}>
          <Plus size={16} /> Nuevo establecimiento
        </button>} />

      {error && <ResourceLoadNotice title="establecimientos" error={error} onRetry={reload} />}
      {dataMode === 'mock' && <p role="status" className="resource-demo-note">Vista de demostración: datos de ejemplo.</p>}
      {/* Stats only represent successfully loaded records */}
      {!loading && !error && <div className="stats-row">
        <div className="stat-tile stat-tile--green">
          <div className="stat-tile__header">
            <span className="stat-tile__label">Establecimientos</span>
          </div>
          <span className="stat-tile__value">{farms.length}</span>
        </div>
        <div className="stat-tile stat-tile--blue">
          <div className="stat-tile__header">
            <span className="stat-tile__label">Lotes totales</span>
          </div>
          <span className="stat-tile__value">{farms.reduce((s, f) => s + (f.Fields?.length || 0), 0)}</span>
        </div>
        <div className="stat-tile stat-tile--amber">
          <div className="stat-tile__header">
            <span className="stat-tile__label">Hectáreas declaradas</span>
          </div>
          <span className="stat-tile__value">
            {farms.reduce((s, f) => s + (f.Fields || []).reduce((fs, field) => fs + Number(field.area_hectares || 0), 0), 0).toLocaleString('es-AR')}
          </span>
        </div>
      </div>}

      {/* Farm Cards */}
      {error ? null : loading ? (
        <CollectionState status="loading" />
      ) : farms.length === 0 ? (
        <CollectionState status="empty" title="Sin establecimientos" icon={Landmark}
          description="Todavía no hay establecimientos registrados para esta empresa."
          action={canEdit && <button type="button" className="primary-action"
            onClick={() => setShowFarmModal(true)}>
            <Plus size={16} /> Nuevo establecimiento
          </button>} />
      ) : (
        <div style={{ display: 'grid', gap: 16 }}>
          {farms.map((farm) => (
            <FarmCard key={farm.id} farm={farm} canEdit={canEdit} onFieldAdded={reload} />
          ))}
        </div>
      )}

      {canEdit && showFarmModal && (
        <FarmFormModal
          isOpen
          onClose={() => setShowFarmModal(false)}
          onCreated={() => { setShowFarmModal(false); reload(); }}
        />
      )}
    </div>
  );
}
