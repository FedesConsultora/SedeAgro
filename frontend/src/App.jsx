import { useMemo, useState } from 'react';
import {
  Activity,
  ClipboardList,
  FileSpreadsheet,
  LayoutDashboard,
  LogOut,
  Map,
  RefreshCw,
  Satellite,
  ShieldAlert,
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
import { FarmsPage } from './pages/FarmsPage.jsx';
import { CampaignsPage } from './pages/CampaignsPage.jsx';
import { ScoutingPage } from './pages/ScoutingPage.jsx';
import { WorkOrdersPage } from './pages/WorkOrdersPage.jsx';
import { ReportsPage } from './pages/ReportsPage.jsx';
import { OperationsPage } from './pages/OperationsPage.jsx';
import { TeamPage } from './pages/TeamPage.jsx';
import { TenantAdminPage } from './pages/TenantAdminPage.jsx';
import { PlatformAdminPage } from './pages/PlatformAdminPage.jsx';
import { LoginPage } from './pages/LoginPage.jsx';
import { RegisterPage } from './pages/RegisterPage.jsx';

const views = [
  { id: 'dashboard', label: 'Panel', icon: LayoutDashboard, entitlement: 'analytics' },
  { id: 'teams', label: 'Equipos', icon: Users, entitlement: 'org' },
  { id: 'fields', label: 'Establecimientos', icon: Map, entitlement: 'gis' },
  { id: 'campaigns', label: 'Campañas', icon: Sprout, entitlement: 'campaigns' },
  { id: 'scouting', label: 'Monitoreo', icon: Activity, entitlement: 'scouting' },
  { id: 'orders', label: 'Órdenes', icon: ClipboardList, entitlement: 'work_orders' },
  { id: 'assets', label: 'Activos', icon: Tractor, entitlement: 'work_orders' },
  { id: 'reports', label: 'Reportes', icon: FileSpreadsheet, entitlement: 'reports' },
  { id: 'imagery', label: 'Satélite', icon: Satellite, entitlement: 'imagery' },
  { id: 'sync', label: 'Sync', icon: RefreshCw, entitlement: 'analytics' }
];

function Shell() {
  const { entitlements, logout, session } = useSession();
  const isPlatformAdmin = session?.user?.isPlatformAdmin;

  const availableViews = useMemo(
    () => views.filter((view) => entitlements.includes(view.entitlement)),
    [entitlements]
  );
  const [activeView, setActiveView] = useState('dashboard');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const currentView = ['admin', 'platform'].includes(activeView)
    ? activeView
    : (availableViews.some((view) => view.id === activeView)
        ? activeView
        : availableViews[0]?.id || 'dashboard');

  // Logout action appended to sidebar views
  const sidebarViews = useMemo(() => [
    ...availableViews,
    { id: '__logout__', label: 'Cerrar sesión', icon: LogOut, entitlement: 'analytics' }
  ], [availableViews]);

  const handleViewChange = (id) => {
    if (id === '__logout__') { logout(); return; }
    setActiveView(id);
    setSidebarOpen(false);
  };

  return (
    <div className={`app-shell ${sidebarCollapsed ? 'app-shell--collapsed' : ''}`}>
      <GlobalLoader />
      <ErrorToast />
      <Sidebar
        views={sidebarViews}
        activeView={currentView}
        onChange={handleViewChange}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        isCollapsed={sidebarCollapsed}
        onCollapseToggle={() => setSidebarCollapsed(!sidebarCollapsed)}
      />

      {sidebarOpen && (
        <div
          className="sidebar-overlay"
          onClick={() => setSidebarOpen(false)}
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.5)',
            backdropFilter: 'blur(4px)',
            WebkitBackdropFilter: 'blur(4px)',
            zIndex: 95
          }}
        />
      )}

      <main className="workspace">
        <Topbar
          onMenuToggle={() => setSidebarOpen(!sidebarOpen)}
          activeView={currentView}
          onViewChange={handleViewChange}
        />
        {currentView === 'dashboard'  && <Dashboard />}
        {currentView === 'fields'     && <FarmsPage />}
        {currentView === 'campaigns'  && <CampaignsPage />}
        {currentView === 'scouting'   && <ScoutingPage />}
        {currentView === 'orders'     && <WorkOrdersPage />}
        {currentView === 'reports'    && <ReportsPage />}
        {currentView === 'teams'      && <TeamPage />}
        {currentView === 'admin'      && <TenantAdminPage />}
        {currentView === 'platform'   && <PlatformAdminPage />}
        {['assets', 'imagery', 'sync'].includes(currentView) && (
          <OperationsPage mode={currentView} />
        )}
      </main>
    </div>
  );
}

export function App() {
  const { isAuthenticated } = useSession();
  const [authView, setAuthView] = useState('login');

  if (!isAuthenticated) {
    return authView === 'login'
      ? <LoginPage onSwitchToRegister={() => setAuthView('register')} />
      : <RegisterPage onSwitchToLogin={() => setAuthView('login')} />;
  }

  return <Shell />;
}
