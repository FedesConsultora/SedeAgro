import { useState } from 'react';
import { FileSpreadsheet } from 'lucide-react';
import { useSession } from '../context/SessionContext.jsx';
import { mockData } from '../services/mockData.js';
import { FieldReportCard } from '../components/FieldReportCard.jsx';
import { ReportJobsPanel } from '../components/ReportJobsPanel.jsx';
import { ResourceLoadNotice } from '../components/ResourceLoadNotice.jsx';
import { useTenantCollection } from '../services/useTenantCollection.js';
import { reportAccessContext } from '../services/reportAccessContext.js';
import { WorkspaceHeading, CollectionState } from '../components/WorkspacePrimitives.jsx';

export function ReportsPage() {
  const { api, dataMode, session } = useSession();
  const { records: fields, loading, error, reload } = useTenantCollection({
    api, method: 'fields', dataMode, tenantId: session?.tenant?.id,
    mockRecords: mockData.fields, title: 'lotes para reportes'
  });
  const [search, setSearch] = useState('');
  const reportPrincipal = reportAccessContext(session, dataMode);

  const visible = search
    ? fields.filter((f) => [f.name, f.Farm?.name].join(' ').toLowerCase().includes(search.toLowerCase()))
    : fields;

  return (
    <div className="page-grid">
      <WorkspaceHeading eyebrow="Análisis por lote" title="Reportes" />

      {dataMode === 'live' && !loading && !error && <ReportJobsPanel key={reportPrincipal || 'unavailable'} fields={fields} />}

      {/* Search bar */}
      <div className="data-table-toolbar" style={{ borderBottom: 'none', padding: 0 }}>
        <div className="data-table-toolbar__search">
          <FileSpreadsheet size={15} />
          <input
            aria-label="Buscar lotes para reportes"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar lote o establecimiento…"
          />
        </div>
        <span role="status" className="workspace-results-count">{loading || error ? "—" : visible.length} lotes</span>
      </div>

      {error && <ResourceLoadNotice title="lotes para reportes" error={error} onRetry={reload} />}
      {dataMode === 'mock' && <p className="resource-demo-note" role="status">Reportes de ejemplo.</p>}
      {error ? null : loading ? (
        <CollectionState status="loading" />
      ) : visible.length === 0 ? (
        <CollectionState status={fields.length === 0 ? 'empty' : 'filtered'} icon={FileSpreadsheet}
          title={fields.length === 0 ? 'Sin lotes para reportar' : 'No hay lotes que coincidan'}
          description={fields.length === 0
            ? 'Todavía no hay lotes disponibles para esta empresa. Revisá Establecimientos.'
            : 'Probá otra búsqueda para encontrar un lote registrado.'}
          action={fields.length > 0 && <button type="button" className="ghost-action"
            onClick={() => setSearch('')}>Limpiar búsqueda</button>} />
      ) : (
        <div style={{ display: 'grid', gap: 16 }}>
          {visible.map((field) => (
            <FieldReportCard
              key={`${reportPrincipal || 'demo'}:${field.id}`}
              fieldId={field.id}
              fieldName={field.name}
              farmName={field.Farm?.name || '–'}
              areaHectares={field.area_hectares}
            />
          ))}
        </div>
      )}
    </div>
  );
}
