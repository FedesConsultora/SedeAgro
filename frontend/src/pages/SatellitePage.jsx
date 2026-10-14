import { useState } from 'react';
import { CalendarDays, Layers, Satellite, Cloud, RefreshCw } from 'lucide-react';
import { useSession } from '../context/SessionContext.jsx';
import { mockData } from '../services/mockData.js';
import { ResourceLoadNotice } from '../components/ResourceLoadNotice.jsx';
import { useTenantCollection } from '../services/useTenantCollection.js';
import './satellite-workspace.css';

const LAYER_ES = {
  ndvi: 'NDVI (índice de vegetación)', gndvi: 'GNDVI',
  rgb: 'Color real', evi: 'EVI (biomasa)',
  moisture: 'Estrés hídrico', other: 'Otro'
};
function dateLabel(value) {
  if (!value) return 'Fecha no informada';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString('es-AR') : 'Fecha no informada';
}
function cloudLabel(value) {
  const n = Number(value);
  return value == null || !Number.isFinite(n) || n < 0 || n > 1
    ? 'No informado' : (n * 100).toLocaleString('es-AR', { maximumFractionDigits: 1 }) + '%';
}
function ndviLabel(value) {
  const n = Number(value);
  return value == null || !Number.isFinite(n) || n < -1 || n > 1
    ? 'No informado' : n.toLocaleString('es-AR', { maximumFractionDigits: 3 });
}

export function SatellitePage() {
  const { api, dataMode, session } = useSession();
  const { records: layers, loading, error, reload } = useTenantCollection({
    api, method: 'satelliteLayers', dataMode, tenantId: session?.tenant?.id,
    mockRecords: mockData.satelliteLayers, title: 'capas satelitales'
  });
  const [selectedId, setSelectedId] = useState(null);
  const current = layers.find(item => item.id === selectedId) || null;

  return (
    <div className="page-grid satellite-workspace">
      <header className="page-heading">
        <div><span className="eyebrow">Sensores remotos</span><h1>Capas satelitales</h1>
          <p className="satellite-workspace__intro">Metadatos registrados y estado de las capas disponibles para tu empresa.</p>
        </div>
        <button type="button" className="ghost-action" onClick={reload} disabled={loading}>
          <RefreshCw size={16} aria-hidden="true" /> Actualizar
        </button>
      </header>
      {dataMode === 'mock' &&
        <p className="resource-demo-note" role="status">Vista de demostración: las capas de ejemplo no representan imágenes procesadas.</p>}
      {error && <ResourceLoadNotice title="capas satelitales" error={error} onRetry={reload} />}
      {!error && <div className="satellite-workspace__layout">
        <section className="satellite-workspace__list" aria-label="Capas disponibles">
          <h2>Capas registradas</h2>
          {loading ? <p role="status">Consultando capas…</p>
            : layers.length === 0 ? <div className="satellite-workspace__empty">
              <Layers size={26} aria-hidden="true" /><strong>Sin capas registradas</strong>
              <p>Todavía no hay datos satelitales disponibles para esta empresa.</p>
            </div> : <div className="satellite-workspace__items">
              {layers.map(layer => <button key={layer.id} type="button"
                className={'satellite-workspace__item ' + (current?.id === layer.id ? 'is-selected' : '')}
                aria-pressed={current?.id === layer.id} onClick={() => setSelectedId(layer.id)}>
                <Satellite size={18} aria-hidden="true" />
                <span><strong>{layer.Field?.name || 'Lote no especificado'}</strong>
                  <small>{LAYER_ES[layer.layer_type] || layer.layer_type || 'Sin tipo'} · {dateLabel(layer.captured_at)}</small>
                </span>
              </button>)}
            </div>}
        </section>
        <section className="satellite-workspace__detail" aria-labelledby="satellite-detail-title">
          <h2 id="satellite-detail-title">Detalle de capa</h2>
          {current ? <>
            <div className="satellite-workspace__summary">
              <strong>{LAYER_ES[current.layer_type] || current.layer_type || 'Capa'}</strong>
              <span>{current.Field?.name || 'Lote no especificado'}</span>
            </div>
            <dl className="satellite-workspace__metadata">
              <div><dt><Satellite size={15} aria-hidden="true" /> Proveedor</dt>
                <dd>{current.provider || 'No informado'}</dd></div>
              <div><dt><CalendarDays size={15} aria-hidden="true" /> Captura</dt>
                <dd>{dateLabel(current.captured_at)}</dd></div>
              <div><dt><Cloud size={15} aria-hidden="true" /> Nubosidad</dt>
                <dd>{cloudLabel(current.metadata?.cloud_cover)}</dd></div>
              <div><dt>NDVI medio</dt><dd>{ndviLabel(current.metadata?.ndvi_mean)}</dd></div>
            </dl>
            <p className="satellite-workspace__disclaimer">
              Los valores no informados no se estiman. La visualización georreferenciada estará
              disponible cuando exista una imagen o mosaico procesado y servido por el backend.
            </p>
          </> : <div className="satellite-workspace__empty">
            <Layers size={26} aria-hidden="true" />
            <p>Seleccioná una capa para consultar sus metadatos. No se muestra un mapa simulado.</p>
          </div>}
        </section>
      </div>}
    </div>
  );
}
