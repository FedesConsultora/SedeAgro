import { useState, useRef, useEffect } from 'react';
import { Bell, LogOut, Menu, Search, Settings, ShieldCheck, User as UserIcon, Users } from 'lucide-react';
import { ConnectionPanel } from './ConnectionPanel.jsx';
import { useSession } from '../context/SessionContext.jsx';

function UserMenu({ activeView, onViewChange }) {
  const { session, logout } = useSession();
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef(null);

  const user = session?.user;
  const roleCode = session?.membership?.roleCode || 'scout';
  const isPlatformAdmin = user?.isPlatformAdmin;
  const isTenantAdmin = roleCode === 'tenant_admin';

  const roleLabels = {
    tenant_admin: 'Administrador',
    agronomic_coordinator: 'Coordinador Agronómico',
    scout: 'Monitoreador',
    contractor: 'Contratista',
    producer_viewer: 'Productor / Cliente'
  };

  const getInitials = (name) => {
    if (!name) return 'U';
    return name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase();
  };

  useEffect(() => {
    function handleClickOutside(event) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const navigate = (viewId) => {
    onViewChange?.(viewId);
    setIsOpen(false);
  };

  return (
    <div className="user-menu" ref={dropdownRef}>
      <button
        className="user-menu__trigger"
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        title="Perfil de usuario"
      >
        <div className="user-menu__avatar" data-admin={isPlatformAdmin ? 'true' : undefined}>
          {getInitials(user?.fullName)}
        </div>
      </button>

      {isOpen && (
        <div className="user-menu__dropdown">
          {/* ── Profile header ── */}
          <div className="user-menu__profile">
            <div className="user-menu__profile-avatar" data-admin={isPlatformAdmin ? 'true' : undefined}>
              {getInitials(user?.fullName)}
            </div>
            <div className="user-menu__profile-info">
              <div className="user-menu__profile-name">
                {user?.fullName || 'Usuario'}
              </div>
              <div className="user-menu__profile-email">
                {user?.email || ''}
              </div>
              <div className="user-menu__profile-badges">
                <span className="status-badge status-badge--blue" style={{ fontSize: 10, padding: '2px 6px' }}>
                  {roleLabels[roleCode] || roleCode}
                </span>
                {isPlatformAdmin && (
                  <span className="status-badge status-badge--rose" style={{ fontSize: 10, padding: '2px 6px' }}>
                    <ShieldCheck size={10} style={{ marginRight: 2 }} /> Platform Admin
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* ── Tenant info ── */}
          <div className="user-menu__section-label">Organización</div>
          <div className="user-menu__tenant">
            <span className="user-menu__tenant-name">{session?.tenant?.name || 'Tenant'}</span>
            <span className="user-menu__tenant-slug">{session?.tenant?.slug || ''}</span>
          </div>

          {/* ── Navigation items ── */}
          <div className="user-menu__divider" />

          <button
            className={`user-menu__item ${activeView === 'teams' ? 'user-menu__item--active' : ''}`}
            type="button"
            onClick={() => navigate('teams')}
          >
            <Users size={14} />
            Mi equipo
          </button>

          {(isTenantAdmin || isPlatformAdmin) && (
            <button
              className={`user-menu__item ${activeView === 'admin' ? 'user-menu__item--active' : ''}`}
              type="button"
              onClick={() => navigate('admin')}
            >
              <Settings size={14} />
              Administración del Tenant
            </button>
          )}

          {isPlatformAdmin && (
            <>
              <div className="user-menu__divider" />
              <div className="user-menu__section-label">Plataforma</div>
              <button
                className={`user-menu__item user-menu__item--platform ${activeView === 'platform' ? 'user-menu__item--active' : ''}`}
                type="button"
                onClick={() => navigate('platform')}
              >
                <ShieldCheck size={14} />
                Gestión de Plataforma
              </button>
            </>
          )}

          <div className="user-menu__divider" />
          <button
            className="user-menu__item user-menu__item--danger"
            type="button"
            onClick={logout}
          >
            <LogOut size={14} />
            Cerrar sesión
          </button>
        </div>
      )}
    </div>
  );
}

export function Topbar({ onMenuToggle, activeView, onViewChange }) {
  return (
    <header className="topbar">
      <button className="menu-toggle" type="button" onClick={onMenuToggle} title="Menu">
        <Menu size={20} />
      </button>
      <div className="search-box">
        <Search size={18} />
        <input placeholder="Buscar lote, campaña u orden" />
      </div>
      <div className="topbar__actions">
        <button className="icon-button" type="button" title="Notificaciones">
          <Bell size={18} />
        </button>
        <ConnectionPanel />
        <UserMenu activeView={activeView} onViewChange={onViewChange} />
      </div>
    </header>
  );
}
