import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, MapPin, Plus, Landmark } from 'lucide-react';
import { useSession } from '../context/SessionContext.jsx';
import { mockData } from '../services/mockData.js';
import { FarmFormModal } from '../components/FarmFormModal.jsx';
import { FieldFormModal } from '../components/FieldFormModal.jsx';

const STATUS_ES = { active: 'Activo', inactive: 'Inactivo', archived: 'Archivado' };

function StatusBadge({ status }) {
  return <span className={`status-badge status-badge--${status}`}>{STATUS_ES[status] || status}</span>;
}

function FarmCard({ farm, onFieldAdded }) {
  const [expanded, setExpanded] = useState(false);
  const [showFieldModal, setShowFieldModal] = useState(false);
  const fields = farm.Fields || [];
  const totalHa = fields.reduce((s, f) => s + Number(f.area_hectares || 0), 0);

  return (
    <div className="farm-card">
      {/* Farm Header */}
      <div className="farm-card__header" onClick={() => setExpanded((v) => !v)} role="button" tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && setExpanded((v) => !v)}>
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
            <span>hectáreas</span>
          </div>
          <div className="stat">
            <strong>{fields.length}</strong>
            <span>{fields.length === 1 ? 'lote' : 'lotes'}</span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            type="button"
            className="ghost-action"
            style={{ minHeight: 34, padding: '0 12px', fontSize: 12 }}
            onClick={(e) => { e.stopPropagation(); setShowFieldModal(true); }}
          >
            <Plus size={14} /> Nuevo lote
          </button>
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
              <div key={field.id} className="field-row">
                <MapPin size={14} style={{ color: '#94a3b8', flexShrink: 0 }} />
                <span className="field-row__name">{field.name}</span>
                <StatusBadge status={field.status} />
                <span className="field-row__ha">{Number(field.area_hectares || 0).toLocaleString('es-AR')} ha</span>
              </div>
            ))
          )}
        </div>
      )}

      {showFieldModal && (
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
  const { api, dataMode } = useSession();
  const [farms, setFarms] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showFarmModal, setShowFarmModal] = useState(false);

  const load = async () => {
    setLoading(true);
    if (dataMode === 'mock') {
      setFarms(mockData.farms);
      setLoading(false);
      return;
    }
    try {
      const res = await api.farms();
      setFarms(res.data || []);
    } catch {
      setFarms(mockData.farms);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [api, dataMode]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="page-grid">
      {/* Header */}
      <section className="page-heading">
        <div>
          <span className="eyebrow">Gestión territorial</span>
          <h1>Establecimientos y lotes</h1>
        </div>
        <button type="button" className="primary-action" onClick={() => setShowFarmModal(true)}>
          <Plus size={16} /> Nuevo establecimiento
        </button>
      </section>

      {/* Stats bar */}
      <div className="stats-row">
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
            <span className="stat-tile__label">Hectáreas</span>
          </div>
          <span className="stat-tile__value">
            {farms.reduce((s, f) => s + (f.Fields || []).reduce((fs, field) => fs + Number(field.area_hectares || 0), 0), 0).toLocaleString('es-AR')}
          </span>
        </div>
      </div>

      {/* Farm Cards */}
      {loading ? (
        <div className="empty-state"><span>Cargando…</span></div>
      ) : farms.length === 0 ? (
        <div className="empty-state">
          <Landmark size={40} />
          <h3>Sin establecimientos</h3>
          <p>Creá tu primer establecimiento para empezar a organizar tus lotes.</p>
          <button type="button" className="primary-action" onClick={() => setShowFarmModal(true)}>
            <Plus size={16} /> Nuevo establecimiento
          </button>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 16 }}>
          {farms.map((farm) => (
            <FarmCard key={farm.id} farm={farm} onFieldAdded={load} />
          ))}
        </div>
      )}

      {showFarmModal && (
        <FarmFormModal
          isOpen
          onClose={() => setShowFarmModal(false)}
          onCreated={() => { setShowFarmModal(false); load(); }}
        />
      )}
    </div>
  );
}
