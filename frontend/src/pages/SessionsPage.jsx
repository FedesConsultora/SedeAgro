import { useCallback, useEffect, useState } from 'react';
import { Clock3, MonitorSmartphone, ShieldCheck, ShieldX, RefreshCw } from 'lucide-react';
import { useSession } from '../context/SessionContext.jsx';

function formatDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('es-AR', {
    dateStyle: 'medium', timeStyle: 'short'
  }) : 'Fecha no disponible';
}

export function SessionsPage() {
  const { api, logout } = useSession();
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await api.sessions();
      setSessions(response.data || []);
    } catch (err) {
      setSessions([]);
      setError(err?.message || 'No se pudo consultar la lista de sesiones.');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { void refresh(); }, [refresh]);

  const revoke = async (item) => {
    if (busyId || item.isCurrent) return;
    if (!window.confirm('¿Cerrar esta sesión en otro navegador o dispositivo? Se desconectará en la próxima solicitud.')) return;
    setBusyId(item.id);
    setError('');
    setNotice('');
    try {
      await api.revokeSession(item.id);
      await refresh();
      setNotice('Se revocó la sesión seleccionada. Los borradores cifrados de ese dispositivo no se eliminaron.');
    } catch (err) {
      setError(err?.message || 'No se pudo cerrar la sesión remota.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="page-content" style={{ maxWidth: 850 }}>
      <header className="page-header">
        <div>
          <h1>Seguridad de sesiones</h1>
          <p>Controlá dónde tenés iniciada sesión. Solo aparecen sesiones de esta cuenta y empresa.</p>
        </div>
      </header>
      <section className="card" style={{ padding: 22 }}>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'space-between',
          alignItems: 'center', flexWrap: 'wrap', marginBottom: 18 }}>
          <div style={{ display: 'flex', gap: 9, alignItems: 'center' }}>
            <ShieldCheck size={20} aria-hidden="true" />
            <strong>Sesiones activas</strong>
          </div>
          <button className="ghost-action" type="button" onClick={() => void refresh()}
            disabled={loading || !!busyId}><RefreshCw size={15} /> Actualizar</button>
        </div>
        <p style={{ fontSize: 13, color: '#64748b', marginBottom: 16 }}>
          Máximo cinco sesiones simultáneas por usuario y empresa. Si se supera el límite,
          el inicio de sesión más antiguo deja de tener acceso. No se muestran contraseñas ni tokens.
        </p>
        {error && <p role="alert" style={{ color: '#b91c1c' }}>{error}</p>}
        {notice && <p role="status" style={{ color: '#166534' }}>{notice}</p>}
        {loading ? <p role="status">Consultando sesiones…</p> :
          sessions.length === 0 ? <p>No hay sesiones activas para mostrar.</p> :
            <div style={{ display: 'grid', gap: 12 }}>
              {sessions.map((item) => (
                <div key={item.id} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  gap: 16, padding: '15px 0', borderBottom: '1px solid #e2e8f0',
                  flexWrap: 'wrap'
                }}>
                  <div style={{ display: 'flex', alignItems: 'start', gap: 10, minWidth: 200 }}>
                    <MonitorSmartphone size={20} style={{ marginTop: 3, flexShrink: 0 }} aria-hidden="true" />
                    <div>
                      <strong>{item.isCurrent ? 'Esta sesión' : 'Otra sesión activa'}</strong>
                      <p style={{ fontSize: 12, color: '#64748b', margin: '4px 0' }}>
                        <Clock3 size={12} aria-hidden="true" style={{ display: 'inline' }} />
                        {' '}Iniciada: {formatDate(item.createdAt)}
                      </p>
                      <p style={{ fontSize: 12, color: '#64748b', margin: '4px 0' }}>
                        Vence: {formatDate(item.expiresAt)}
                      </p>
                    </div>
                  </div>
                  {item.isCurrent ? (
                    <button type="button" className="ghost-action" onClick={() => void logout()}>
                      Cerrar mi sesión
                    </button>
                  ) : (
                    <button className="ghost-action" type="button" disabled={Boolean(busyId)}
                      onClick={() => void revoke(item)}>
                      <ShieldX size={15} aria-hidden="true" />
                      {busyId === item.id ? 'Revocando…' : 'Cerrar sesión'}
                    </button>
                  )}
                </div>
              ))}
            </div>
        }
      </section>
    </div>
  );
}
