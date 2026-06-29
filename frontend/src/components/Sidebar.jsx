import { ChevronLeft, ChevronRight, Leaf } from 'lucide-react';

export function Sidebar({ views, activeView, onChange, isOpen, onClose, isCollapsed, onCollapseToggle }) {
  return (
    <aside className={`sidebar ${isOpen ? 'sidebar--open' : ''} ${isCollapsed ? 'sidebar--collapsed' : ''}`}>
      <div className="brand">
        <span className="brand__mark"><Leaf size={20} /></span>
        {!isCollapsed && <span className="brand__name">SedeAgro</span>}
      </div>
      <nav className="sidebar__nav" aria-label="Principal">
        {views.map((view) => {
          const Icon = view.icon;
          return (
            <button
              key={view.id}
              type="button"
              className={activeView === view.id ? 'sidebar__item sidebar__item--active' : 'sidebar__item'}
              onClick={() => {
                onChange(view.id);
                if (onClose) onClose();
              }}
              title={view.label}
            >
              <Icon size={18} />
              {!isCollapsed && <span>{view.label}</span>}
            </button>
          );
        })}
      </nav>

      {/* Collapse Trigger Button (Visible only on desktop screens) */}
      <button 
        className="sidebar__collapse-btn" 
        type="button" 
        onClick={onCollapseToggle}
        aria-label={isCollapsed ? 'Expandir barra lateral' : 'Colapsar barra lateral'}
      >
        {isCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
      </button>
    </aside>
  );
}
