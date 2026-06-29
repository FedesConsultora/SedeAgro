import { useEffect, useState } from 'react';
import { Mail, Plus, Shield, ShieldCheck, UserPlus, Users as UsersIcon } from 'lucide-react';
import { useSession } from '../context/SessionContext.jsx';
import { mockData } from '../services/mockData.js';
import { Modal } from '../components/Modal.jsx';

const ROLE_LABELS = {
  platform_admin: 'Admin Plataforma',
  tenant_admin: 'Administrador',
  agronomic_coordinator: 'Coordinador',
  scout: 'Monitoreador',
  contractor: 'Contratista',
  producer_viewer: 'Productor'
};

const ROLE_TONES = {
  platform_admin: 'rose',
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

function InviteMemberModal({ open, onClose, onInvited }) {
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState('scout');

  const handleSubmit = (e) => {
    e.preventDefault();
    onInvited({ email, fullName, role });
    setEmail(''); setFullName(''); setRole('scout');
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="Invitar miembro">
      <form onSubmit={handleSubmit}>
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
            {Object.entries(ROLE_LABELS).filter(([k]) => k !== 'platform_admin').map(([code, label]) => (
              <option key={code} value={code}>{label}</option>
            ))}
          </select>
        </label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
          <button type="button" className="ghost-action" onClick={onClose}>Cancelar</button>
          <button type="submit" className="primary-action"><UserPlus size={15} /> Invitar</button>
        </div>
      </form>
    </Modal>
  );
}

function MemberCard({ member }) {
  const user = member.User || {};
  const roleCode = member.role_code;
  const tone = ROLE_TONES[roleCode] || 'slate';
  const isPlatformAdmin = user.is_platform_admin;

  return (
    <div className="member-card">
      <div className="member-card__avatar" data-tone={tone}>
        {getInitials(user.full_name)}
      </div>
      <div className="member-card__info">
        <div className="member-card__name">
          {user.full_name || 'Sin nombre'}
          {isPlatformAdmin && (
            <span className="member-card__platform-badge" title="Administrador de plataforma">
              <ShieldCheck size={13} />
            </span>
          )}
        </div>
        <div className="member-card__email">
          <Mail size={12} />
          {user.email || '–'}
        </div>
      </div>
      <div className="member-card__meta">
        <span className={`status-badge status-badge--${tone}`}>
          {ROLE_LABELS[roleCode] || roleCode}
        </span>
        <span className={`status-badge status-badge--${user.status === 'active' ? 'green' : 'slate'}`}>
          {user.status === 'active' ? 'Activo' : user.status || '–'}
        </span>
      </div>
    </div>
  );
}

function TeamCard({ team }) {
  const members = team.TeamMembers || [];

  return (
    <div className="team-tile">
      <div className="team-tile__header">
        <h3>{team.name}</h3>
        <span className={`status-badge status-badge--${team.scope === 'field_ops' ? 'green' : team.scope === 'agronomy' ? 'blue' : 'slate'}`}>
          {team.scope}
        </span>
      </div>
      {team.notes && <p className="team-tile__notes">{team.notes}</p>}
      <div className="team-tile__members">
        {members.length === 0 ? (
          <span style={{ fontSize: 12, color: '#94a3b8' }}>Sin miembros asignados</span>
        ) : (
          members.map((tm) => (
            <div key={tm.id} className="team-tile__member">
              <div className="member-card__avatar member-card__avatar--sm" data-tone="green">
                {getInitials(tm.User?.full_name)}
              </div>
              <span>{tm.User?.full_name || tm.user_id}</span>
              <span className="status-badge status-badge--slate">{tm.role_label || 'member'}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export function TeamPage() {
  const { api, dataMode } = useSession();
  const [members, setMembers] = useState([]);
  const [teams, setTeams] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showInvite, setShowInvite] = useState(false);

  useEffect(() => {
    let mounted = true;
    async function load() {
      setLoading(true);
      if (dataMode === 'mock') {
        setMembers([
          { id: '1', role_code: 'tenant_admin', status: 'active', User: { full_name: 'Ana López (Admin)', email: 'admin@agro-demo.test', status: 'active', is_platform_admin: true } },
          { id: '2', role_code: 'agronomic_coordinator', status: 'active', User: { full_name: 'Carlos Martínez (Coord)', email: 'coordinador@agro-demo.test', status: 'active' } },
          { id: '3', role_code: 'scout', status: 'active', User: { full_name: 'Laura Gómez (Scout)', email: 'monitor@agro-demo.test', status: 'active' } },
          { id: '4', role_code: 'contractor', status: 'active', User: { full_name: 'Pedro Ruiz (Contratista)', email: 'contratista@agro-demo.test', status: 'active' } },
          { id: '5', role_code: 'producer_viewer', status: 'active', User: { full_name: 'María Torres (Productor)', email: 'productor@agro-demo.test', status: 'active' } }
        ]);
        setTeams(mockData.teams || []);
        setLoading(false);
        return;
      }
      try {
        const [membersRes, teamsRes] = await Promise.all([api.members(), api.teams()]);
        if (mounted) {
          setMembers(Array.isArray(membersRes?.data) ? membersRes.data : []);
          setTeams(Array.isArray(teamsRes?.data) ? teamsRes.data : []);
        }
      } catch {
        // fallback to mock
        setMembers([]);
        setTeams([]);
      } finally {
        if (mounted) setLoading(false);
      }
    }
    load();
    return () => { mounted = false; };
  }, [api, dataMode]);

  const handleInvited = (data) => {
    // In MVP mock mode, add to local state
    setMembers(prev => [...prev, {
      id: `mock-${Date.now()}`,
      role_code: data.role,
      status: 'active',
      User: { full_name: data.fullName, email: data.email, status: 'active' }
    }]);
  };

  const platformAdmins = members.filter(m => m.User?.is_platform_admin);
  const regularMembers = members.filter(m => !m.User?.is_platform_admin);

  return (
    <div className="page-grid">
      <section className="page-heading">
        <div>
          <span className="eyebrow">Organización</span>
          <h1>Equipo</h1>
        </div>
        <button type="button" className="primary-action" onClick={() => setShowInvite(true)}>
          <UserPlus size={16} /> Invitar miembro
        </button>
      </section>

      {loading ? (
        <div className="empty-state"><span>Cargando equipo…</span></div>
      ) : (
        <>
          {/* Platform admins section */}
          {platformAdmins.length > 0 && (
            <section className="team-section">
              <div className="team-section__header">
                <Shield size={16} style={{ color: '#f43f5e' }} />
                <h2>Administradores de plataforma</h2>
                <span style={{ fontSize: 12, color: '#94a3b8' }}>Acceso global a todos los tenants</span>
              </div>
              <div className="member-grid">
                {platformAdmins.map(m => <MemberCard key={m.id} member={m} />)}
              </div>
            </section>
          )}

          {/* Members section */}
          <section className="team-section">
            <div className="team-section__header">
              <UsersIcon size={16} style={{ color: '#059669' }} />
              <h2>Miembros del tenant</h2>
              <span className="team-section__count">{regularMembers.length}</span>
            </div>
            {regularMembers.length === 0 ? (
              <div className="empty-state">
                <UsersIcon size={40} />
                <h3>Sin miembros</h3>
                <p>Invitá usuarios para que se unan a la organización.</p>
              </div>
            ) : (
              <div className="member-grid">
                {regularMembers.map(m => <MemberCard key={m.id} member={m} />)}
              </div>
            )}
          </section>

          {/* Teams section */}
          <section className="team-section">
            <div className="team-section__header">
              <UsersIcon size={16} style={{ color: '#0ea5e9' }} />
              <h2>Equipos de trabajo</h2>
              <span className="team-section__count">{teams.length}</span>
            </div>
            {teams.length === 0 ? (
              <div className="empty-state">
                <UsersIcon size={40} />
                <h3>Sin equipos</h3>
                <p>Creá equipos para organizar las tareas de campo.</p>
              </div>
            ) : (
              <div className="team-grid">
                {teams.map(t => <TeamCard key={t.id} team={t} />)}
              </div>
            )}
          </section>
        </>
      )}

      <InviteMemberModal open={showInvite} onClose={() => setShowInvite(false)} onInvited={handleInvited} />
    </div>
  );
}
