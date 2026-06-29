import { useMemo, useState } from 'react';
import {
  Activity,
  ClipboardList,
  FileSpreadsheet,
  LayoutDashboard,
  Map,
  RefreshCw,
  Satellite,
  Sprout,
  Tractor,
  Users
} from 'lucide-react';
import { useSession } from './context/SessionContext.jsx';
import { Sidebar } from './components/Sidebar.jsx';
import { Topbar } from './components/Topbar.jsx';
import { ErrorToast } from './components/ErrorToast.jsx';
import { GlobalLoader } from './components/GlobalLoader.jsx';
import { Dashboard } from './pages/Dashboard.jsx';
import { FieldsPage } from './pages/FieldsPage.jsx';
import { OperationsPage } from './pages/OperationsPage.jsx';

const views = [
  { id: 'dashboard', label: 'Panel', icon: LayoutDashboard, entitlement: 'analytics' },
  { id: 'teams', label: 'Equipos', icon: Users, entitlement: 'org' },
  { id: 'fields', label: 'Lotes', icon: Map, entitlement: 'gis' },
  { id: 'campaigns', label: 'Campañas', icon: Sprout, entitlement: 'campaigns' },
  { id: 'scouting', label: 'Monitoreo', icon: Activity, entitlement: 'scouting' },
  { id: 'orders', label: 'Órdenes', icon: ClipboardList, entitlement: 'work_orders' },
  { id: 'assets', label: 'Activos', icon: Tractor, entitlement: 'work_orders' },
  { id: 'reports', label: 'Reportes', icon: FileSpreadsheet, entitlement: 'reports' },
  { id: 'imagery', label: 'Satélite', icon: Satellite, entitlement: 'imagery' },
  { id: 'sync', label: 'Sync', icon: RefreshCw, entitlement: 'analytics' }
];

function Shell() {
  const { entitlements } = useSession();
  const availableViews = useMemo(
    () => views.filter((view) => entitlements.includes(view.entitlement)),
    [entitlements]
  );
  const [activeView, setActiveView] = useState('dashboard');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const currentView = availableViews.some((view) => view.id === activeView)
    ? activeView
    : availableViews[0]?.id || 'dashboard';

  return (
    <div className={`app-shell ${sidebarCollapsed ? 'app-shell--collapsed' : ''}`}>
      <GlobalLoader />
      <ErrorToast />
      <Sidebar 
        views={availableViews} 
        activeView={currentView} 
        onChange={setActiveView} 
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        isCollapsed={sidebarCollapsed}
        onCollapseToggle={() => setSidebarCollapsed(!sidebarCollapsed)}
      />
      
      {/* Mobile backdrop overlay */}
      {sidebarOpen && (
        <div 
          className="sidebar-overlay" 
          onClick={() => setSidebarOpen(false)} 
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            backdropFilter: 'blur(4px)',
            webkitBackdropFilter: 'blur(4px)',
            zIndex: 95
          }}
        />
      )}

      <main className="workspace">
        <Topbar onMenuToggle={() => setSidebarOpen(!sidebarOpen)} />
        {currentView === 'dashboard' && <Dashboard />}
        {currentView === 'fields' && <FieldsPage />}
        {['teams', 'campaigns', 'scouting', 'orders', 'assets', 'reports', 'imagery', 'sync'].includes(currentView) && (
          <OperationsPage mode={currentView} />
        )}
      </main>
    </div>
  );
}

export function App() {
  return <Shell />;
}
