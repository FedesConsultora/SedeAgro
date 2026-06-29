import { useEffect, useState } from 'react';
import { Building2, Database, Globe, Layers, Package, ShieldCheck, Sparkles, ToggleLeft, ToggleRight, User, Users, Ban, CheckCircle, Settings, Eye } from 'lucide-react';
import { useSession } from '../context/SessionContext.jsx';
import { Modal } from '../components/Modal.jsx';

const TABS = [
  { id: 'tenants', label: 'Tenants', icon: Building2 },
  { id: 'users', label: 'Usuarios', icon: Users },
  { id: 'plans', label: 'Planes', icon: Sparkles },
  { id: 'system', label: 'Sistema', icon: Globe }
];

const TENANT_STATUS = {
  active: { label: 'Activo', tone: 'green' },
  onboarding: { label: 'Onboarding', tone: 'blue' },
  suspended: { label: 'Suspendido', tone: 'rose' },
  archived: { label: 'Archivado', tone: 'slate' }
};

// ── Tenants Tab ───────────────────────────────────────────────
function TenantsTab({ tenants, plans, onUpdateStatus, onUpdatePlan, onOpenModules }) {
  return (
    <div className="admin-tab-content">
      <div className="admin-tab-content__header">
        <div>
          <h2>Organizaciones registradas</h2>
          <p>Todas las empresas suscritas a la plataforma SedeAgro.</p>
        </div>
        <div className="admin-tab-content__stats">
          <div className="admin-stat">
            <span className="admin-stat__value">{tenants.length}</span>
            <span className="admin-stat__label">Tenants</span>
          </div>
          <div className="admin-stat">
            <span className="admin-stat__value">{tenants.filter(t => t.status === 'active').length}</span>
            <span className="admin-stat__label">Activos</span>
          </div>
        </div>
      </div>

      <div className="admin-table">
        <div className="admin-table__head">
          <span>Organización</span>
          <span>Slug</span>
          <span>Plan</span>
          <span>Estado</span>
          <span>Acciones</span>
        </div>
        {tenants.map(t => {
          const st = TENANT_STATUS[t.status] || TENANT_STATUS.active;
          return (
            <div className="admin-table__row" key={t.id}>
              <span>
                <strong>{t.name}</strong>
                {t.billing_email && <div className="admin-table__sub">{t.billing_email}</div>}
              </span>
              <span className="admin-table__mono">{t.slug}</span>
              <span>
                <select
                  className="admin-select"
                  value={t.plan_id || ''}
                  onChange={e => onUpdatePlan(t.id, e.target.value)}
                >
                  <option value="">Sin plan</option>
                  {plans.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </span>
              <span>
                <span className={`status-badge status-badge--${st.tone}`}>{st.label}</span>
              </span>
              <span className="admin-table__actions">
                <button type="button" className="ghost-action ghost-action--sm" onClick={() => onOpenModules(t)} title="Módulos">
                  <Settings size={12} /> Módulos
                </button>
                {t.status === 'active' ? (
                  <button type="button" className="ghost-action ghost-action--sm ghost-action--danger" onClick={() => onUpdateStatus(t.id, 'suspended')} title="Suspender">
                    <Ban size={12} />
                  </button>
                ) : (
                  <button type="button" className="ghost-action ghost-action--sm ghost-action--success" onClick={() => onUpdateStatus(t.id, 'active')} title="Activar">
                    <CheckCircle size={12} />
                  </button>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Users Tab ─────────────────────────────────────────────────
function UsersTab({ users }) {
  return (
    <div className="admin-tab-content">
      <div className="admin-tab-content__header">
        <div>
          <h2>Usuarios del sistema</h2>
          <p>Todos los usuarios registrados en la plataforma, independientemente del tenant.</p>
        </div>
        <div className="admin-tab-content__stats">
          <div className="admin-stat">
            <span className="admin-stat__value">{users.length}</span>
            <span className="admin-stat__label">Total</span>
          </div>
          <div className="admin-stat">
            <span className="admin-stat__value">{users.filter(u => u.is_platform_admin).length}</span>
            <span className="admin-stat__label">Admins</span>
          </div>
        </div>
      </div>

      <div className="admin-table">
        <div className="admin-table__head">
          <span>Nombre</span>
          <span>Email</span>
          <span>Estado</span>
          <span>Tipo</span>
          <span>Registrado</span>
        </div>
        {users.map(u => (
          <div className="admin-table__row" key={u.id}>
            <span><strong>{u.full_name}</strong></span>
            <span className="admin-table__muted">{u.email}</span>
            <span>
              <span className={`status-badge status-badge--${u.status === 'active' ? 'green' : 'slate'}`}>
                {u.status}
              </span>
            </span>
            <span>
              {u.is_platform_admin ? (
                <span className="status-badge status-badge--rose" style={{ fontSize: 10 }}>
                  <ShieldCheck size={10} style={{ marginRight: 2 }} /> Platform Admin
                </span>
              ) : (
                <span className="status-badge status-badge--slate" style={{ fontSize: 10 }}>Usuario</span>
              )}
            </span>
            <span className="admin-table__muted">{u.created_at ? new Date(u.created_at).toLocaleDateString('es-AR') : '–'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Plans Tab ─────────────────────────────────────────────────
function PlansTab({ plans }) {
  return (
    <div className="admin-tab-content">
      <div className="admin-tab-content__header">
        <div>
          <h2>Planes de suscripción</h2>
          <p>Configuración de planes disponibles y sus límites.</p>
        </div>
      </div>

      <div className="admin-plans-grid">
        {plans.map(p => (
          <div className="admin-plan-card" key={p.id}>
            <div className="admin-plan-card__icon">
              <Package size={24} />
            </div>
            <h3>{p.name}</h3>
            <span className="admin-plan-card__code">{p.code}</span>
            <div className="admin-plan-card__limits">
              <div className="admin-plan-card__limit">
                <Users size={14} />
                <span>{p.max_users} usuarios máx.</span>
              </div>
              <div className="admin-plan-card__limit">
                <Layers size={14} />
                <span>{p.max_hectares ? `${p.max_hectares} ha` : 'Ilimitado'}</span>
              </div>
            </div>
            <div className="admin-plan-card__features">
              {(p.modules || ['org', 'gis', 'campaigns']).map(m => (
                <span key={m} className="status-badge status-badge--blue" style={{ fontSize: 10 }}>{m}</span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── System Tab ────────────────────────────────────────────────
function SystemTab() {
  return (
    <div className="admin-tab-content">
      <div className="admin-tab-content__header">
        <div>
          <h2>Estado del sistema</h2>
          <p>Información técnica de la plataforma SedeAgro.</p>
        </div>
      </div>

      <div className="admin-system-grid">
        <div className="admin-system-card">
          <h4>Versión</h4>
          <span className="admin-system-card__value">MVP 0.1.0</span>
        </div>
        <div className="admin-system-card">
          <h4>Entorno</h4>
          <span className="admin-system-card__value">Development</span>
        </div>
        <div className="admin-system-card">
          <h4>Base de datos</h4>
          <span className="admin-system-card__value">PostgreSQL 15</span>
        </div>
        <div className="admin-system-card">
          <h4>Cache</h4>
          <span className="admin-system-card__value">Redis 7</span>
        </div>
        <div className="admin-system-card">
          <h4>API</h4>
          <span className="admin-system-card__value">REST v1</span>
        </div>
        <div className="admin-system-card">
          <h4>Auth</h4>
          <span className="admin-system-card__value">JWT + scrypt</span>
        </div>
      </div>
    </div>
  );
}

// ── Modules Config Modal ──────────────────────────────────────
function ModulesModal({ tenant, onClose, dataMode, api }) {
  const [modules, setModules] = useState([]);
  const [enabled, setEnabled] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      if (dataMode === 'mock') {
        setModules([
          { code: 'org', name: 'Base organizacional' },
          { code: 'gis', name: 'GIS y lotes' },
          { code: 'campaigns', name: 'Campañas y cultivos' },
          { code: 'scouting', name: 'Monitoreo de campo' },
          { code: 'work_orders', name: 'Órdenes de trabajo' },
          { code: 'reports', name: 'Reportes' },
          { code: 'imagery', name: 'Imágenes satelitales' },
          { code: 'analytics', name: 'Analytics' }
        ]);
        setEnabled(['org', 'gis', 'campaigns', 'scouting', 'work_orders', 'analytics']);
        setLoading(false);
        return;
      }
      try {
        const res = await api.getPlatformTenantModules(tenant.id);
        setModules(res.data.modules || []);
        setEnabled(res.data.enabled || []);
      } catch { /* ignore */ }
      setLoading(false);
    }
    load();
  }, [tenant, dataMode, api]);

  const toggle = async (code) => {
    const isEnabled = enabled.includes(code);
    const next = isEnabled ? enabled.filter(c => c !== code) : [...enabled, code];
    setEnabled(next);
    if (dataMode !== 'mock') {
      try {
        await api.togglePlatformTenantModule(tenant.id, { module_code: code, is_enabled: !isEnabled });
      } catch { /* ignore */ }
    }
  };

  return (
    <Modal open onClose={onClose} title={`Módulos – ${tenant.name}`}>
      {loading ? (
        <div style={{ padding: 20, textAlign: 'center' }}>Cargando…</div>
      ) : (
        <div className="admin-modules-grid" style={{ margin: '12px 0 20px' }}>
          {modules.map(mod => {
            const isOn = enabled.includes(mod.code);
            return (
              <div className={`admin-module-card ${isOn ? 'admin-module-card--active' : ''}`} key={mod.code}>
                <div className="admin-module-card__info">
                  <h3>{mod.name}</h3>
                  <span className="admin-module-card__code">{mod.code}</span>
                </div>
                <label className="admin-toggle">
                  <input type="checkbox" checked={isOn} onChange={() => toggle(mod.code)} />
                  <span className="admin-toggle__track">
                    <span className="admin-toggle__thumb" />
                  </span>
                </label>
              </div>
            );
          })}
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button type="button" className="primary-action" onClick={onClose}>Listo</button>
      </div>
    </Modal>
  );
}

// ── Main Page ─────────────────────────────────────────────────
export function PlatformAdminPage() {
  const { api, dataMode } = useSession();
  const [tab, setTab] = useState('tenants');
  const [tenants, setTenants] = useState([]);
  const [users, setUsers] = useState([]);
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedTenantModules, setSelectedTenantModules] = useState(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      if (dataMode === 'mock') {
        setTenants([
          { id: '1', name: 'Agro Demo', slug: 'agro-demo', status: 'active', plan_id: '1', billing_email: 'admin@agro-demo.test', Plan: { name: 'Starter Agro' } },
          { id: '2', name: 'Campo Grande S.A.', slug: 'campo-grande', status: 'onboarding', plan_id: null, billing_email: 'info@campogrande.com', Plan: null },
          { id: '3', name: 'Estancia Los Álamos', slug: 'los-alamos', status: 'suspended', plan_id: '1', billing_email: null, Plan: { name: 'Starter Agro' } }
        ]);
        setUsers([
          { id: '1', email: 'admin@agro-demo.test', full_name: 'Ana López', status: 'active', is_platform_admin: true, created_at: '2026-06-20T00:00:00Z' },
          { id: '2', email: 'coordinador@agro-demo.test', full_name: 'Carlos Martínez', status: 'active', is_platform_admin: false, created_at: '2026-06-20T00:00:00Z' },
          { id: '3', email: 'monitor@agro-demo.test', full_name: 'Laura Gómez', status: 'active', is_platform_admin: false, created_at: '2026-06-21T00:00:00Z' },
          { id: '4', email: 'contratista@agro-demo.test', full_name: 'Pedro Ruiz', status: 'active', is_platform_admin: false, created_at: '2026-06-22T00:00:00Z' },
          { id: '5', email: 'productor@agro-demo.test', full_name: 'María Torres', status: 'active', is_platform_admin: false, created_at: '2026-06-23T00:00:00Z' }
        ]);
        setPlans([
          { id: '1', code: 'starter', name: 'Starter Agro', max_users: 8, max_hectares: 5000, modules: ['org', 'gis', 'campaigns', 'scouting'] },
          { id: '2', code: 'pro', name: 'Pro Agro', max_users: 25, max_hectares: 50000, modules: ['org', 'gis', 'campaigns', 'scouting', 'work_orders', 'reports'] },
          { id: '3', code: 'enterprise', name: 'Enterprise', max_users: null, max_hectares: null, modules: ['org', 'gis', 'campaigns', 'scouting', 'work_orders', 'reports', 'imagery', 'analytics'] }
        ]);
        setLoading(false);
        return;
      }
      try {
        const [tRes, uRes, pRes] = await Promise.all([
          api.getPlatformTenants(),
          api.getPlatformUsers(),
          api.getPlatformPlans()
        ]);
        setTenants(tRes.data || []);
        setUsers(uRes.data || []);
        setPlans(pRes.data || []);
      } catch { /* ignore */ }
      setLoading(false);
    }
    load();
  }, [api, dataMode]);

  const handleUpdateStatus = (id, status) => {
    setTenants(prev => prev.map(t => t.id === id ? { ...t, status } : t));
    if (dataMode !== 'mock') api.updatePlatformTenant(id, { status }).catch(() => {});
  };

  const handleUpdatePlan = (id, planId) => {
    const plan = plans.find(p => p.id === planId);
    setTenants(prev => prev.map(t => t.id === id ? { ...t, plan_id: planId, Plan: plan || null } : t));
    if (dataMode !== 'mock') api.updatePlatformTenant(id, { plan_id: planId }).catch(() => {});
  };

  return (
    <div className="page-grid">
      <section className="page-heading page-heading--platform">
        <div>
          <span className="eyebrow eyebrow--platform">
            <ShieldCheck size={13} /> Administración de Plataforma
          </span>
          <h1>SedeAgro Master</h1>
        </div>
      </section>

      {/* ── Tab navigation ── */}
      <nav className="admin-tabs admin-tabs--platform">
        {TABS.map(t => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              type="button"
              className={`admin-tabs__tab ${tab === t.id ? 'admin-tabs__tab--active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              <Icon size={15} />
              <span>{t.label}</span>
            </button>
          );
        })}
      </nav>

      {/* ── Tab content ── */}
      <div className="admin-panel admin-panel--platform">
        {loading ? (
          <div className="empty-state"><span>Cargando datos de plataforma…</span></div>
        ) : (
          <>
            {tab === 'tenants' && (
              <TenantsTab
                tenants={tenants}
                plans={plans}
                onUpdateStatus={handleUpdateStatus}
                onUpdatePlan={handleUpdatePlan}
                onOpenModules={setSelectedTenantModules}
              />
            )}
            {tab === 'users' && <UsersTab users={users} />}
            {tab === 'plans' && <PlansTab plans={plans} />}
            {tab === 'system' && <SystemTab />}
          </>
        )}
      </div>

      {/* ── Modules modal ── */}
      {selectedTenantModules && (
        <ModulesModal
          tenant={selectedTenantModules}
          onClose={() => setSelectedTenantModules(null)}
          dataMode={dataMode}
          api={api}
        />
      )}
    </div>
  );
}
