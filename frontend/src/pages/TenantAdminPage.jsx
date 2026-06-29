import { useEffect, useState } from 'react';
import { Building2, Users, Settings, Shield, Key, Bell, Activity, Plus, Mail, Pencil, Trash2 } from 'lucide-react';
import { useSession } from '../context/SessionContext.jsx';
import { Modal } from '../components/Modal.jsx';

const TABS = [
  { id: 'members', label: 'Miembros', icon: Users },
  { id: 'roles', label: 'Roles y permisos', icon: Key },
  { id: 'modules', label: 'Módulos', icon: Settings },
  { id: 'org', label: 'Organización', icon: Building2 },
  { id: 'audit', label: 'Actividad', icon: Activity }
];

const ROLE_LABELS = {
  tenant_admin: 'Administrador',
  agronomic_coordinator: 'Coordinador',
  scout: 'Monitoreador',
  contractor: 'Contratista',
  producer_viewer: 'Productor'
};

const ROLE_TONES = {
  tenant_admin: 'amber',
  agronomic_coordinator: 'blue',
  scout: 'green',
  contractor: 'slate',
  producer_viewer: 'slate'
};

function getInitials(name) {
  if (!name) return '?';
  return name.split(' ').filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase();
}

// ── Members Tab ───────────────────────────────────────────────
function MembersTab({ members, onInvite }) {
  return (
    <div className="admin-tab-content">
      <div className="admin-tab-content__header">
        <div>
          <h2>Miembros de la organización</h2>
          <p>Gestioná los usuarios que tienen acceso al sistema.</p>
        </div>
        <button type="button" className="primary-action" onClick={onInvite}>
          <Plus size={14} /> Invitar miembro
        </button>
      </div>

      <div className="admin-table">
        <div className="admin-table__head">
          <span>Usuario</span>
          <span>Email</span>
          <span>Rol</span>
          <span>Estado</span>
          <span>Acciones</span>
        </div>
        {members.map(m => {
          const user = m.User || {};
          const tone = ROLE_TONES[m.role_code] || 'slate';
          return (
            <div className="admin-table__row" key={m.id}>
              <span className="admin-table__user">
                <div className="member-card__avatar member-card__avatar--sm" data-tone={tone}>
                  {getInitials(user.full_name)}
                </div>
                <strong>{user.full_name || '–'}</strong>
              </span>
              <span className="admin-table__muted">{user.email || '–'}</span>
              <span>
                <span className={`status-badge status-badge--${tone}`}>
                  {ROLE_LABELS[m.role_code] || m.role_code}
                </span>
              </span>
              <span>
                <span className={`status-badge status-badge--${user.status === 'active' ? 'green' : 'slate'}`}>
                  {user.status === 'active' ? 'Activo' : user.status || '–'}
                </span>
              </span>
              <span className="admin-table__actions">
                <button type="button" className="ghost-action ghost-action--sm" title="Editar">
                  <Pencil size={12} />
                </button>
                <button type="button" className="ghost-action ghost-action--sm ghost-action--danger" title="Eliminar">
                  <Trash2 size={12} />
                </button>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Roles Tab ─────────────────────────────────────────────────
function RolesTab() {
  const roles = [
    { code: 'tenant_admin', name: 'Administrador', desc: 'Acceso total al tenant. Puede gestionar usuarios, configuraciones y datos.', perms: ['Crear/editar/eliminar recursos', 'Gestionar miembros', 'Configurar módulos', 'Ver reportes'] },
    { code: 'agronomic_coordinator', name: 'Coordinador Agronómico', desc: 'Coordina campañas, monitoreos y órdenes de trabajo.', perms: ['Crear campañas', 'Asignar monitoreos', 'Crear órdenes', 'Ver reportes'] },
    { code: 'scout', name: 'Monitoreador', desc: 'Realiza recorridas de campo y registra observaciones.', perms: ['Crear observaciones', 'Subir evidencia', 'Ver lotes asignados'] },
    { code: 'contractor', name: 'Contratista', desc: 'Ejecuta las órdenes de trabajo y labores asignadas.', perms: ['Ver órdenes asignadas', 'Actualizar estado de labores', 'Registrar insumos usados'] },
    { code: 'producer_viewer', name: 'Productor / Cliente', desc: 'Vista de lectura para productores y clientes externos.', perms: ['Ver lotes propios', 'Ver reportes', 'Ver campañas'] }
  ];

  return (
    <div className="admin-tab-content">
      <div className="admin-tab-content__header">
        <div>
          <h2>Roles y permisos</h2>
          <p>Estructura de roles del sistema con sus permisos asociados.</p>
        </div>
      </div>

      <div className="admin-roles-grid">
        {roles.map(r => (
          <div className="admin-role-card" key={r.code}>
            <div className="admin-role-card__header">
              <Shield size={16} />
              <h3>{r.name}</h3>
              <span className={`status-badge status-badge--${ROLE_TONES[r.code] || 'slate'}`} style={{ fontSize: 10 }}>
                {r.code}
              </span>
            </div>
            <p className="admin-role-card__desc">{r.desc}</p>
            <ul className="admin-role-card__perms">
              {r.perms.map(p => (
                <li key={p}><span className="admin-role-card__check">✓</span> {p}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Modules Tab ───────────────────────────────────────────────
function ModulesTab({ modules, onToggle }) {
  return (
    <div className="admin-tab-content">
      <div className="admin-tab-content__header">
        <div>
          <h2>Módulos habilitados</h2>
          <p>Activá o desactivá funcionalidades para tu organización.</p>
        </div>
      </div>

      <div className="admin-modules-grid">
        {modules.map(mod => (
          <div className={`admin-module-card ${mod.enabled ? 'admin-module-card--active' : ''}`} key={mod.code}>
            <div className="admin-module-card__info">
              <h3>{mod.name}</h3>
              <span className="admin-module-card__code">{mod.code}</span>
            </div>
            <label className="admin-toggle">
              <input
                type="checkbox"
                checked={mod.enabled}
                onChange={() => onToggle(mod.code)}
              />
              <span className="admin-toggle__track">
                <span className="admin-toggle__thumb" />
              </span>
            </label>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Org Tab ───────────────────────────────────────────────────
function OrgTab({ tenant }) {
  return (
    <div className="admin-tab-content">
      <div className="admin-tab-content__header">
        <div>
          <h2>Datos de la organización</h2>
          <p>Información general del tenant y configuración básica.</p>
        </div>
      </div>

      <div className="admin-org-grid">
        <div className="admin-org-field">
          <label>Nombre</label>
          <input type="text" defaultValue={tenant?.name || 'Agro Demo'} readOnly />
        </div>
        <div className="admin-org-field">
          <label>Slug / URL</label>
          <input type="text" defaultValue={tenant?.slug || 'agro-demo'} readOnly />
        </div>
        <div className="admin-org-field">
          <label>Estado</label>
          <span className={`status-badge status-badge--${tenant?.status === 'active' ? 'green' : 'slate'}`}>
            {tenant?.status || 'active'}
          </span>
        </div>
        <div className="admin-org-field">
          <label>Email de facturación</label>
          <input type="email" defaultValue={tenant?.billing_email || 'admin@agro-demo.test'} readOnly />
        </div>
      </div>
    </div>
  );
}

// ── Audit Tab ─────────────────────────────────────────────────
function AuditTab() {
  const logs = [
    { ts: '2026-06-29 10:15', actor: 'Ana López', action: 'Inició sesión', detail: 'IP 192.168.0.10' },
    { ts: '2026-06-29 10:18', actor: 'Ana López', action: 'Creó campo "Lote Norte"', detail: '54 ha' },
    { ts: '2026-06-29 10:20', actor: 'Carlos Martínez', action: 'Creó campaña "2025/26"', detail: 'Soja + Maíz' },
    { ts: '2026-06-29 10:45', actor: 'Laura Gómez', action: 'Registró observación', detail: 'Roya asiática detectada' },
    { ts: '2026-06-29 11:02', actor: 'Ana López', action: 'Creó orden de trabajo', detail: 'Aplicación fungicida' }
  ];

  return (
    <div className="admin-tab-content">
      <div className="admin-tab-content__header">
        <div>
          <h2>Registro de actividad</h2>
          <p>Últimas acciones realizadas en la organización.</p>
        </div>
      </div>

      <div className="admin-table">
        <div className="admin-table__head">
          <span>Fecha / hora</span>
          <span>Usuario</span>
          <span>Acción</span>
          <span>Detalle</span>
        </div>
        {logs.map((l, i) => (
          <div className="admin-table__row" key={i}>
            <span className="admin-table__muted">{l.ts}</span>
            <span><strong>{l.actor}</strong></span>
            <span>{l.action}</span>
            <span className="admin-table__muted">{l.detail}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────
export function TenantAdminPage() {
  const { api, dataMode, session } = useSession();
  const [tab, setTab] = useState('members');
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showInvite, setShowInvite] = useState(false);
  const [modules, setModules] = useState([]);

  useEffect(() => {
    let mounted = true;
    async function load() {
      setLoading(true);
      if (dataMode === 'mock') {
        setMembers([
          { id: '1', role_code: 'tenant_admin', User: { full_name: 'Ana López', email: 'admin@agro-demo.test', status: 'active', is_platform_admin: true } },
          { id: '2', role_code: 'agronomic_coordinator', User: { full_name: 'Carlos Martínez', email: 'coordinador@agro-demo.test', status: 'active' } },
          { id: '3', role_code: 'scout', User: { full_name: 'Laura Gómez', email: 'monitor@agro-demo.test', status: 'active' } },
          { id: '4', role_code: 'contractor', User: { full_name: 'Pedro Ruiz', email: 'contratista@agro-demo.test', status: 'active' } },
          { id: '5', role_code: 'producer_viewer', User: { full_name: 'María Torres', email: 'productor@agro-demo.test', status: 'active' } }
        ]);
        setModules([
          { code: 'org', name: 'Base organizacional', enabled: true },
          { code: 'gis', name: 'GIS y lotes', enabled: true },
          { code: 'campaigns', name: 'Campañas y cultivos', enabled: true },
          { code: 'scouting', name: 'Monitoreo de campo', enabled: true },
          { code: 'work_orders', name: 'Órdenes de trabajo', enabled: true },
          { code: 'reports', name: 'Reportes', enabled: true },
          { code: 'imagery', name: 'Imágenes satelitales', enabled: false },
          { code: 'analytics', name: 'Analytics y panel', enabled: true }
        ]);
        setLoading(false);
        return;
      }
      try {
        const res = await api.members();
        if (mounted) setMembers(Array.isArray(res?.data) ? res.data : []);
      } catch { /* ignore */ }
      setLoading(false);
    }
    load();
    return () => { mounted = false; };
  }, [api, dataMode]);

  const toggleModule = (code) => {
    setModules(prev => prev.map(m => m.code === code ? { ...m, enabled: !m.enabled } : m));
  };

  const handleInvited = (data) => {
    setMembers(prev => [...prev, {
      id: `inv-${Date.now()}`,
      role_code: data.role,
      User: { full_name: data.fullName, email: data.email, status: 'active' }
    }]);
    setShowInvite(false);
  };

  return (
    <div className="page-grid">
      <section className="page-heading">
        <div>
          <span className="eyebrow">Administración</span>
          <h1>{session?.tenant?.name || 'Organización'}</h1>
        </div>
      </section>

      {/* ── Tab navigation ── */}
      <nav className="admin-tabs">
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
      <div className="admin-panel">
        {loading ? (
          <div className="empty-state"><span>Cargando…</span></div>
        ) : (
          <>
            {tab === 'members' && <MembersTab members={members} onInvite={() => setShowInvite(true)} />}
            {tab === 'roles' && <RolesTab />}
            {tab === 'modules' && <ModulesTab modules={modules} onToggle={toggleModule} />}
            {tab === 'org' && <OrgTab tenant={session?.tenant} />}
            {tab === 'audit' && <AuditTab />}
          </>
        )}
      </div>

      {/* ── Invite modal ── */}
      {showInvite && (
        <Modal open={showInvite} onClose={() => setShowInvite(false)} title="Invitar miembro">
          <InviteForm onSubmit={handleInvited} onCancel={() => setShowInvite(false)} />
        </Modal>
      )}
    </div>
  );
}

function InviteForm({ onSubmit, onCancel }) {
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState('scout');

  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit({ email, fullName, role }); }}>
      <div className="form-row">
        <label className="form-field">
          <span>Nombre completo</span>
          <input value={fullName} onChange={e => setFullName(e.target.value)} required placeholder="Juan Pérez" />
        </label>
        <label className="form-field">
          <span>Email</span>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} required placeholder="juan@empresa.test" />
        </label>
      </div>
      <label className="form-field">
        <span>Rol</span>
        <select value={role} onChange={e => setRole(e.target.value)}>
          {Object.entries(ROLE_LABELS).map(([code, label]) => (
            <option key={code} value={code}>{label}</option>
          ))}
        </select>
      </label>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
        <button type="button" className="ghost-action" onClick={onCancel}>Cancelar</button>
        <button type="submit" className="primary-action"><Mail size={15} /> Invitar</button>
      </div>
    </form>
  );
}
