import { useCallback, useEffect, useState } from 'react';
import { useSession } from '../context/SessionContext.jsx';

const ACTION_ES = {
  'scouting.run.created': 'Recorrida creada',
  'scouting.run.updated': 'Datos de recorrida actualizados',
  'scouting.run.status_changed': 'Estado actualizado',
  'scouting.observation.created': 'Observación registrada',
  'scouting.observation.synced': 'Observación sincronizada',
  'scouting.evidence.uploaded': 'Evidencia adjuntada'
};

export function ScoutingAuditPanel({ runId }) {
  const { api, dataMode } = useSession();
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    if (dataMode !== 'live') return;
    setLoading(true);
    setError('');
    try {
      const response = await api.getScoutingAudit(runId);
      setEvents(response.data || []);
    } catch (err) {
      setEvents([]);
      setError(err?.message || 'No se pudo consultar el historial.');
    } finally {
      setLoading(false);
    }
  }, [api, dataMode, runId]);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <section aria-label="Historial de recorrida" style={{ borderTop: '1px solid rgba(15,23,42,0.1)', paddingTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <strong style={{ fontSize: 13 }}>Historial de cambios</strong>
        <button type="button" className="ghost-action" onClick={() => void refresh()} disabled={loading}>Actualizar</button>
      </div>
      {loading && <p role="status" style={{ fontSize: 12 }}>Consultando movimientos…</p>}
      {error && <p role="alert" style={{ fontSize: 12, color: '#b91c1c' }}>{error}</p>}
      {!loading && !error && events.length === 0 &&
        <p style={{ fontSize: 12, color: '#64748b' }}>No hay movimientos auditados para esta recorrida.</p>}
      {!loading && !error && <ol style={{ paddingLeft: 24, display: 'grid', gap: 10 }}>
        {events.map((event) => (
          <li key={event.id} style={{ color: '#475569', fontSize: 12 }}>
            <strong>{ACTION_ES[event.action] || event.action}</strong>
            <div>{new Date(event.created_at).toLocaleString('es-AR')}</div>
            {event.before?.status !== event.after?.status && event.after?.status &&
              <div>Estado: {event.before?.status || '—'} → {event.after.status}</div>}
            <div style={{ fontSize: 11, opacity: 0.72 }}>Actor: {event.actor_id || 'sin identificación'}</div>
          </li>
        ))}
      </ol>}
      <p style={{ fontSize: 11, color: '#64748b' }}>Se registran metadatos mínimos. No se copian archivos ni notas de campo al historial.</p>
    </section>
  );
}
