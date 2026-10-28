import { useEffect, useRef, useState } from 'react';
import { Plus, UserPlus } from 'lucide-react';
import {
  TEAM_SCOPES, liveTeamAuthority, eligibleTeamMembers,
  prepareLiveTeamCreation, confirmLiveTeamCreation,
  prepareLiveTeamMember, confirmLiveTeamMember
} from '../services/teamOperationsSafety.js';

const LABELS = {
  field_ops: 'Operaciones de campo', agronomy: 'Agronomía',
  contractor: 'Contratistas', client: 'Productores / clientes',
  support: 'Soporte'
};

export function TeamOperationsPanel({ api, session, dataMode, teams, members, onUpdated }) {
  const authority = liveTeamAuthority(session, dataMode);
  const tenantId = session?.tenant?.id;
  const scopeRef = useRef(authority);
  scopeRef.current = authority;
  const apiRef = useRef(api);
  apiRef.current = api;
  const pending = useRef(null);
  if (pending.current &&
      (pending.current.authority !== authority || pending.current.api !== api)) {
    pending.current = null;
  }
  const [creating, setCreating] = useState({ name: '', scope: 'field_ops' });
  const [adding, setAdding] = useState({ teamId: '', userId: '', roleLabel: 'Integrante' });
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(null);
  const visibleBusy = busy?.authority === authority && busy?.api === api;
  const visibleNotice = notice?.authority === authority && notice?.api === api
    ? notice : null;

  useEffect(() => {
    pending.current = null;
    setBusy(null);
    setNotice(null);
    setCreating({ name: '', scope: 'field_ops' });
    setAdding({ teamId: '', userId: '', roleLabel: 'Integrante' });
  }, [authority, api]);

  const selectedTeam = teams.find(team => team.id === adding.teamId);
  const candidates = eligibleTeamMembers(members, selectedTeam);
  const currentTeamId = selectedTeam ? selectedTeam.id : '';
  const currentUserId = candidates.some(member => member.user_id === adding.userId)
    ? adding.userId : '';
  const isCurrent = ticket => scopeRef.current === ticket.authority &&
    apiRef.current === ticket.api && pending.current === ticket;

  const perform = async (kind, prepared, action, confirm) => {
    if (!authority || pending.current) return;
    const ticket = { authority, api };
    pending.current = ticket; // synchronous lock prevents double submits
    setBusy({ authority, api, kind });
    setNotice(null);
    try {
      const response = await action(prepared);
      if (!isCurrent(ticket)) return;
      confirm(response, prepared, tenantId);
      if (!isCurrent(ticket)) return;
      if (kind === 'create') setCreating({ name: '', scope: 'field_ops' });
      if (kind === 'member') setAdding({ teamId: '', userId: '', roleLabel: 'Integrante' });
      setNotice({ authority, api, type: 'success',
        message: kind === 'create' ? 'Equipo confirmado. Actualizando listado…' :
          'Integrante agregado. Actualizando listado…' });
      onUpdated();
    } catch (error) {
      if (isCurrent(ticket)) {
        setNotice({ authority, api, type: 'error',
          message: 'No quedó confirmada la operación. Revisá el listado actualizado antes de reintentar. ' +
            (error?.message || 'Sin confirmación del servidor.') });
        onUpdated();
      }
    } finally {
      if (isCurrent(ticket)) {
        pending.current = null;
        setBusy(null);
      }
    }
  };

  const submitCreate = event => {
    event.preventDefault();
    if (pending.current || !authority) return;
    let request;
    try { request = prepareLiveTeamCreation(creating, authority); }
    catch (error) {
      setNotice({ authority, api, type: 'error', message: error.message }); return;
    }
    void perform('create', request, body => api.createTeam(body),
      (response, expected, tenant) => confirmLiveTeamCreation(response, expected, tenant));
  };

  const submitMember = event => {
    event.preventDefault();
    if (pending.current || !authority) return;
    let request;
    try { request = prepareLiveTeamMember({
      ...adding, teamId: currentTeamId, userId: currentUserId
    }, teams, members, authority); }
    catch (error) {
      setNotice({ authority, api, type: 'error', message: error.message }); return;
    }
    void perform('member', request, input => api.addTeamMember(input.teamId, input.body),
      (response, expected, tenant) => confirmLiveTeamMember(response, expected, tenant));
  };

  if (!authority) return null;

  return (
    <section className="team-section" aria-label="Administrar equipos de trabajo">
      <div className="team-section__header">
        <Plus size={17} aria-hidden="true" />
        <h2>Organizar equipos</h2>
      </div>
      <p>Creá un equipo operativo y sumá colaboradores con membresía activa en esta empresa.
        No modifica sus permisos ni sus roles de acceso.</p>
      <form onSubmit={submitCreate} aria-label="Crear equipo de trabajo"
        style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
        <label className="form-field" style={{ flex: '1 1 210px' }}>
          Nombre del equipo
          <input type="text" required minLength={2} maxLength={160}
            value={creating.name} disabled={Boolean(visibleBusy)}
            placeholder="Monitoreo zona norte"
            onChange={e => setCreating(value => ({ ...value, name: e.target.value }))} />
        </label>
        <label className="form-field" style={{ flex: '1 1 160px' }}>
          Área operativa
          <select value={creating.scope} disabled={Boolean(visibleBusy)}
            onChange={e => setCreating(value => ({ ...value, scope: e.target.value }))}>
            {TEAM_SCOPES.map(scope => (
              <option key={scope} value={scope}>{LABELS[scope]}</option>
            ))}
          </select>
        </label>
        <button className="primary-action" type="submit"
          disabled={Boolean(visibleBusy)} aria-busy={Boolean(visibleBusy && busy.kind === 'create')}>
          <Plus size={15} aria-hidden="true" /> Crear equipo
        </button>
      </form>
      {teams.length > 0 && (
        <form onSubmit={submitMember} aria-label="Agregar integrante a un equipo"
          style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end', marginTop: 16 }}>
          <label className="form-field" style={{ flex: '1 1 160px' }}>
            Equipo
            <select value={currentTeamId} required disabled={Boolean(visibleBusy)}
              onChange={e => setAdding(value => ({ ...value, teamId: e.target.value, userId: '' }))}>
              <option value="">Seleccionar equipo</option>
              {teams.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}
            </select>
          </label>
          <label className="form-field" style={{ flex: '1 1 190px' }}>
            Integrante activo
            <select value={currentUserId} required
              disabled={Boolean(visibleBusy) || !currentTeamId || candidates.length === 0}
              onChange={e => setAdding(value => ({ ...value, userId: e.target.value }))}>
              <option value="">Seleccionar colaborador</option>
              {candidates.map(member => <option key={member.user_id} value={member.user_id}>
                {member.User.full_name} ({member.User.email})
              </option>)}
            </select>
          </label>
          <label className="form-field" style={{ flex: '1 1 140px' }}>
            Función en el equipo
            <input type="text" required minLength={2} maxLength={80}
              disabled={Boolean(visibleBusy) || !currentTeamId} value={adding.roleLabel}
              onChange={e => setAdding(value => ({ ...value, roleLabel: e.target.value }))} />
          </label>
          <button className="primary-action" type="submit"
            disabled={Boolean(visibleBusy) || !currentUserId}
            aria-busy={Boolean(visibleBusy && busy.kind === 'member')}>
            <UserPlus size={15} aria-hidden="true" /> Agregar integrante
          </button>
          {currentTeamId && candidates.length === 0 &&
            <small>Todos los colaboradores activos ya pertenecen a este equipo.</small>}
        </form>
      )}
      {visibleNotice && <p role={visibleNotice.type === 'error' ? 'alert' : 'status'}
        className={visibleNotice.type === 'error' ? 'resource-error' : 'resource-demo-note'}>
        {visibleNotice.message}
      </p>}
    </section>
  );
}
