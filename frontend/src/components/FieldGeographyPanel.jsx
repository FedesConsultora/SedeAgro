import { useEffect, useState } from 'react';
import { ExternalLink, MapPin, RefreshCw, X } from 'lucide-react';
import { useSession } from '../context/SessionContext.jsx';
import { fieldGeography, parseFieldDetail } from '../services/fieldGeography.js';
import './field-geography.css';

const STATUS_ES = { active: 'Activo', inactive: 'Inactivo', archived: 'Archivado' };
const coords = (n) => n.toFixed(5);

export function FieldGeographyPanel({ field, farm, onClose }) {
  const { api, dataMode, session } = useSession();
  const scope = dataMode === 'mock' ? `demo:${farm.id}:${field.id}` :
    `${session?.tenant?.id || ''}:${session?.user?.id || ''}:${farm.id}:${field.id}`;
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState({ scope: null, status: 'loading', record: null, error: '' });

  useEffect(() => {
    let cancelled = false;
    setResult({ scope, status: 'loading', record: null, error: '' });
    if (dataMode === 'mock') {
      setResult({ scope, status: 'ready', record: field, error: '' });
      return () => { cancelled = true; };
    }
    if (!session?.authenticated || !session?.tenant?.id || !session?.user?.id) {
      setResult({ scope, status: 'error', record: null, error: 'No hay una sesión válida para consultar este lote.' });
      return () => { cancelled = true; };
    }
    Promise.resolve().then(() => api.getField(field.id)).then(response => {
      const record = parseFieldDetail(response, field.id, farm.id);
      if (!cancelled) setResult({ scope, status: 'ready', record, error: '' });
    }).catch(error => {
      if (!cancelled) setResult({
        scope, status: 'error', record: null,
        error: error?.message || 'No se pudo consultar la geometría de este lote.'
      });
    });
    return () => { cancelled = true; };
  }, [api, dataMode, field, field.id, farm.id, revision, scope,
      session?.authenticated, session?.tenant?.id, session?.user?.id]);

  const visible = result.scope === scope ? result :
    { scope, status: 'loading', record: null, error: '' };
  const record = visible.status === 'ready' ? visible.record : null;
  const geo = record ? fieldGeography(record.boundary, farm.centroid) : null;

  return (
    <section className="field-geography" aria-label={`Geografía del lote ${field.name}`}>
      <div className="field-geography__header">
        <div><span className="field-geography__eyebrow">Contexto territorial</span><h3>{field.name}</h3></div>
        <div className="field-geography__actions">
          {dataMode === 'live' && <button type="button" className="ghost-action"
            disabled={visible.status === 'loading'}
            onClick={() => setRevision(value => value + 1)}>
            <RefreshCw size={14} /> Actualizar
          </button>}
          <button type="button" className="ghost-action" onClick={onClose} aria-label="Cerrar detalle geográfico">
            <X size={15} /> Cerrar
          </button>
        </div>
      </div>

      {visible.status === 'loading' && <p role="status">Consultando el lote y su perímetro…</p>}
      {visible.status === 'error' && <div className="auth-error" role="alert">
        {visible.error} <button type="button" onClick={() => setRevision(value => value + 1)}>Reintentar</button>
      </div>}
      {record && <>
        <div className="field-geography__facts">
          <div><span>Establecimiento</span><strong>{farm.name}</strong></div>
          <div><span>Estado</span><strong>{STATUS_ES[record.status] || record.status || 'No informado'}</strong></div>
          <div><span>Superficie declarada</span><strong>{record.area_hectares == null ? 'No informada' :
            `${Number(record.area_hectares).toLocaleString('es-AR')} ha`}</strong></div>
        </div>
        {geo.kind === 'polygon' ? (
          <div className="field-geography__layout">
            <figure className="field-geography__figure">
              <svg viewBox="0 0 400 240" role="img"
                aria-label={`Croquis del perímetro real del lote ${field.name}, con ${geo.rings} anillos GeoJSON`}
                preserveAspectRatio="xMidYMid meet">
                <path d={geo.path} fill="#d9ede0" stroke="#267448" strokeWidth="2.5"
                  strokeLinejoin="round" fillRule="evenodd" />
              </svg>
              <figcaption>Croquis vectorial del perímetro registrado · sin mapa base ni imagen satelital</figcaption>
            </figure>
            <div className="field-geography__metadata">
              <strong>Perímetro georreferenciado</strong>
              <p>Geometría Polygon (EPSG:4326). Vista orientativa a escala local, no es un plano catastral.</p>
              <dl>
                <div><dt>Norte</dt><dd>{coords(geo.bbox.north)}°</dd></div>
                <div><dt>Sur</dt><dd>{coords(geo.bbox.south)}°</dd></div>
                <div><dt>Oeste</dt><dd>{coords(geo.bbox.west)}°</dd></div>
                <div><dt>Este</dt><dd>{coords(geo.bbox.east)}°</dd></div>
              </dl>
              <a className="field-geography__external" href={geo.url} target="_blank" rel="noopener noreferrer">
                <ExternalLink size={15} /> Abrir zona en OpenStreetMap
              </a>
              <small>OpenStreetMap abre la zona, pero no superpone el perímetro del lote.</small>
            </div>
          </div>
        ) : (
          <div className="field-geography__missing" role="status">
            <MapPin size={19} />
            <div>
              <strong>{geo.kind === 'invalid' ? 'Perímetro no representable' : 'Sin perímetro digitalizado'}</strong>
              <p>{geo.reason}</p>
              {geo.farmUrl && <a href={geo.farmUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink size={14} /> Ver ubicación declarada del establecimiento
              </a>}
              {geo.farmUrl && <small>Esta coordenada corresponde al establecimiento, no al lote.</small>}
            </div>
          </div>
        )}
        {record.notes && <p className="field-geography__notes"><strong>Notas:</strong> {record.notes}</p>}
        {dataMode === 'mock' && <p className="resource-demo-note" role="status">Modo demostración: sin consulta de geometría real al servidor.</p>}
      </>}
    </section>
  );
}
