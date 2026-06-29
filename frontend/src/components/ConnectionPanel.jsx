import { useMemo, useState } from 'react';
import { Database, FlaskConical, RotateCcw, Save, Settings2, X } from 'lucide-react';
import { API_URL } from '../services/api.js';
import { demoSession, useSession } from '../context/SessionContext.jsx';

export function ConnectionPanel() {
  const { session, setSession, dataMode, setDataMode } = useSession();
  const [isOpen, setIsOpen] = useState(false);
  const [draft, setDraft] = useState(() => ({
    tenantId: session?.tenant?.id || '',
    tenantName: session?.tenant?.name || '',
    token: session?.token || '',
    userName: session?.user?.fullName || ''
  }));

  const modeLabel = useMemo(() => dataMode === 'live' ? 'Backend' : 'Mock', [dataMode]);

  const handleSave = (event) => {
    event.preventDefault();
    setSession({
      ...session,
      token: draft.token.trim(),
      tenant: {
        ...(session?.tenant || {}),
        id: draft.tenantId.trim(),
        name: draft.tenantName.trim() || 'Tenant'
      },
      user: {
        ...(session?.user || {}),
        fullName: draft.userName.trim() || 'Equipo SedeAgro'
      }
    });
    setIsOpen(false);
  };

  const handleDemo = () => {
    setSession(demoSession);
    setDataMode('mock');
    setDraft({
      tenantId: demoSession.tenant.id,
      tenantName: demoSession.tenant.name,
      token: demoSession.token,
      userName: demoSession.user.fullName
    });
  };

  return (
    <div className="connection">
      <button
        className="tenant-switcher"
        type="button"
        onClick={() => setIsOpen((current) => !current)}
        aria-expanded={isOpen}
      >
        <span className={`mode-dot mode-dot--${dataMode}`} />
        <span>{session?.tenant?.name || 'Tenant'}</span>
        <Settings2 size={16} />
      </button>

      {isOpen && (
        <form className="connection-panel" onSubmit={handleSave}>
          <div className="connection-panel__header">
            <div>
              <strong>Conexion</strong>
              <span>{modeLabel} · {API_URL}</span>
            </div>
            <button className="icon-button" type="button" onClick={() => setIsOpen(false)} title="Cerrar">
              <X size={16} />
            </button>
          </div>

          <div className="segmented-control" role="group" aria-label="Modo de datos">
            <button
              type="button"
              className={dataMode === 'mock' ? 'segmented-control__item segmented-control__item--active' : 'segmented-control__item'}
              onClick={() => setDataMode('mock')}
            >
              <FlaskConical size={16} />
              Mock
            </button>
            <button
              type="button"
              className={dataMode === 'live' ? 'segmented-control__item segmented-control__item--active' : 'segmented-control__item'}
              onClick={() => setDataMode('live')}
            >
              <Database size={16} />
              Backend
            </button>
          </div>

          <label className="form-field">
            <span>Tenant ID</span>
            <input value={draft.tenantId} onChange={(event) => setDraft({ ...draft, tenantId: event.target.value })} />
          </label>
          <label className="form-field">
            <span>Tenant</span>
            <input value={draft.tenantName} onChange={(event) => setDraft({ ...draft, tenantName: event.target.value })} />
          </label>
          <label className="form-field">
            <span>Usuario</span>
            <input value={draft.userName} onChange={(event) => setDraft({ ...draft, userName: event.target.value })} />
          </label>
          <label className="form-field">
            <span>Token</span>
            <textarea
              rows={3}
              value={draft.token}
              onChange={(event) => setDraft({ ...draft, token: event.target.value })}
            />
          </label>

          <div className="connection-panel__footer">
            <button className="ghost-action" type="button" onClick={handleDemo}>
              <RotateCcw size={15} />
              Demo
            </button>
            <button className="primary-action" type="submit">
              <Save size={15} />
              Guardar
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
