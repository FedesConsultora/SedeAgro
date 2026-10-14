import { useState } from 'react';
import { ExternalLink, MapPin, MapPinOff } from 'lucide-react';
import {
  GEO_STATUS, observationMapUrl, scoutingObservationGeography
} from '../services/scoutingObservationGeography.js';
import './scouting-observation-geo.css';

const TYPES = {
  weed: 'Maleza', pest: 'Plaga', disease: 'Enfermedad', phenology: 'Fenología',
  nutrition: 'Nutrición', water: 'Agua', general: 'General'
};
const SEVERITY = {
  low: 'Leve', medium: 'Moderada', high: 'Alta', critical: 'Crítica'
};

const FILTERS = [
  { key: 'all', label: 'Todas' },
  { key: 'located', label: 'Con GPS' },
  { key: 'outside', label: 'Fuera del lote' },
  { key: 'missing', label: 'Sin GPS / inválidas' }
];

function dateLabel(value) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return 'Fecha no informada';
  return new Date(value).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
}

export function ScoutingObservationGeoPanel({ observations, boundary, fieldName }) {
  const [filter, setFilter] = useState('all');
  const [selectedId, setSelectedId] = useState(null);
  const view = scoutingObservationGeography(observations, boundary);
  const { field, rows, plotted, totals, mode } = view;
  const located = totals.inside + totals.border + totals.outside + totals.located + totals.unprojected;
  const missing = totals.missing + totals.invalid;
  const shown = rows.filter(row =>
    filter === 'all' ? true :
      filter === 'located' ? Boolean(row.point) :
        filter === 'outside' ? row.status === 'outside' :
          ['missing', 'invalid'].includes(row.status));

  return (
    <section className="scouting-geo" aria-label="Localización de las observaciones">
      <div className="scouting-geo__heading">
        <div>
          <span className="scouting-geo__eyebrow">Observaciones georreferenciadas</span>
          <h3>Ubicación de hallazgos {fieldName ? `· ${fieldName}` : ''}</h3>
        </div>
        <div className="scouting-geo__count" role="status">
          <span><MapPin size={14} aria-hidden="true" /> {located} con GPS</span>
          <span><MapPinOff size={14} aria-hidden="true" /> {missing} sin GPS válido</span>
        </div>
      </div>
      <p className="scouting-geo__hint">
        Posiciones registradas en observaciones confirmadas por el servidor, no borradores pendientes.
        No se muestran imágenes satelitales ni se calcula superficie o precisión catastral.
      </p>
      {mode === 'field' && <p className="scouting-geo__hint" role="status">
        Perímetro registrado de este lote. {totals.outside > 0
          ? `${totals.outside} observación(es) con GPS aparecen fuera de ese límite; revisá su ubicación.`
          : 'Los marcadores que aparecen en el croquis están dentro o sobre el límite registrado.'}
      </p>}
      {mode === 'gps' && <p className="scouting-geo__hint" role="status">
        El lote no tiene perímetro registrado: se muestra únicamente la distribución relativa
        de los puntos GPS capturados, sin afirmar que están dentro del lote.
      </p>}
      {mode === 'unavailable' && <p className="scouting-geo__hint" role="status">
        {field.kind === 'invalid'
          ? 'El perímetro no es representable; conservamos las coordenadas de los registros sin dibujar una figura falsa.'
          : located
            ? 'Los GPS están demasiado dispersos para un croquis local fiable. Consultá cada ubicación individual.'
            : 'Todavía no hay puntos GPS válidos para representar.'}
      </p>}
      {mode !== 'unavailable' && <figure className="scouting-geo__figure">
        <svg viewBox="0 0 400 240" role="img"
          aria-label={mode === 'field'
            ? `Croquis del perímetro del lote con ${plotted.length} observaciones ubicadas`
            : `Diagrama sin perímetro con ${plotted.length} observaciones GPS`}>
          {mode === 'field' && <path d={field.path} className="scouting-geo__boundary" fillRule="evenodd" />}
          {plotted.map(row => (
            <g key={row.id}>
              <circle
                cx={row.position.x} cy={row.position.y}
                r={row.id === selectedId ? 8 : 5}
                className={`scouting-geo__marker scouting-geo__marker--${row.severity in SEVERITY ? row.severity : 'unknown'}`}
                strokeWidth={row.id === selectedId ? 3.5 : 1.5}
              />
              <title>{`#${row.order} ${TYPES[row.type] || 'Observación'} — ${GEO_STATUS[row.status]}`}</title>
            </g>
          ))}
        </svg>
        <figcaption>
          {mode === 'field' ? 'Croquis del perímetro registrado · ' : 'Distribución GPS relativa · '}
          sin mapa base. Los puntos fuera del perímetro se muestran en la lista, no sobre el croquis.
        </figcaption>
      </figure>}
      {view.skippedMarkers > 0 && <p className="scouting-geo__hint" role="status">
        Hay {view.skippedMarkers} ubicaciones adicionales que no se dibujaron para mantener legible el croquis.
        Sus datos siguen disponibles en el listado.
      </p>}
      <div className="scouting-geo__filters" role="group" aria-label="Filtrar observaciones por GPS">
        {FILTERS.map(option => (
          <button key={option.key} type="button" className="ghost-action"
            aria-pressed={filter === option.key} onClick={() => setFilter(option.key)}>
            {option.label}
          </button>
        ))}
      </div>
      {shown.length === 0 ? <p className="scouting-geo__empty" role="status">
        No hay observaciones en este filtro.
      </p> : <ol className="scouting-geo__list">
        {shown.map(row => (
          <li key={row.id} className={row.id === selectedId ? 'scouting-geo__item scouting-geo__item--selected' : 'scouting-geo__item'}>
            <button type="button" className="scouting-geo__selection" aria-pressed={row.id === selectedId}
              onClick={() => setSelectedId(value => value === row.id ? null : row.id)}>
              <span className="scouting-geo__ordinal">#{row.order}</span>
              <span className="scouting-geo__item-body">
                <strong>{TYPES[row.type] || 'Observación'} · {SEVERITY[row.severity] || 'Sin severidad'}</strong>
                <span>{GEO_STATUS[row.status]} · {dateLabel(row.observedAt)}</span>
              </span>
            </button>
            {row.point && <div className="scouting-geo__coordinates">
              <span>{row.point.coordinates[1].toFixed(5)}°, {row.point.coordinates[0].toFixed(5)}°</span>
              <a href={observationMapUrl(row.point)} target="_blank" rel="noopener noreferrer">
                <ExternalLink size={13} aria-hidden="true" /> Abrir ubicación en OpenStreetMap
              </a>
            </div>}
          </li>
        ))}
      </ol>}
      <p className="scouting-geo__hint">
        Los puntos de GPS son aproximados; pueden estar cerca o fuera del borde real.
        OpenStreetMap se abre solo cuando elegís un enlace y no recibe un polígono del lote.
      </p>
    </section>
  );
}
