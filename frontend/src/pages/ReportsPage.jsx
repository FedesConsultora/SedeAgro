import { useEffect, useState } from 'react';
import { FileSpreadsheet } from 'lucide-react';
import { useSession } from '../context/SessionContext.jsx';
import { mockData } from '../services/mockData.js';
import { FieldReportCard } from '../components/FieldReportCard.jsx';

export function ReportsPage() {
  const { api, dataMode } = useSession();
  const [fields, setFields] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      if (dataMode === 'mock') { setFields(mockData.fields); setLoading(false); return; }
      try {
        const res = await api.fields();
        setFields(res.data || []);
      } catch {
        setFields(mockData.fields);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [api, dataMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = search
    ? fields.filter((f) => [f.name, f.Farm?.name].join(' ').toLowerCase().includes(search.toLowerCase()))
    : fields;

  return (
    <div className="page-grid">
      <section className="page-heading">
        <div>
          <span className="eyebrow">Análisis por lote</span>
          <h1>Reportes</h1>
        </div>
      </section>

      {/* Search bar */}
      <div className="data-table-toolbar" style={{ borderBottom: 'none', padding: 0 }}>
        <div className="data-table-toolbar__search">
          <FileSpreadsheet size={15} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar lote o establecimiento…"
          />
        </div>
        <span style={{ fontSize: 13, color: '#64748b' }}>{visible.length} lotes</span>
      </div>

      {loading ? (
        <div className="empty-state"><span>Cargando lotes…</span></div>
      ) : visible.length === 0 ? (
        <div className="empty-state">
          <FileSpreadsheet size={40} />
          <h3>Sin lotes</h3>
          <p>Creá lotes en Establecimientos para ver sus reportes aquí.</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 16 }}>
          {visible.map((field) => (
            <FieldReportCard
              key={field.id}
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
