import { Bell, Menu, Search } from 'lucide-react';
import { ConnectionPanel } from './ConnectionPanel.jsx';

export function Topbar({ onMenuToggle }) {
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
      </div>
    </header>
  );
}
