import { useEffect, useRef, useState } from 'react';
import { Mail, UserPlus } from 'lucide-react';
import {
  MEMBER_INVITE_ROLES, checkedMemberInvitations, confirmMemberInvitation,
  createMemberInviteGate, memberInviteAuthority, prepareMemberInvitation
} from '../services/memberInvitationSafety.js';

const ROLE_NAMES = {
  scout: 'Monitoreador', contractor: 'Contratista',
  agronomic_coordinator: 'Coordinador', producer_viewer: 'Productor'
};

export function MemberInvitationPanel({ api, session, dataMode }) {
  const scope = memberInviteAuthority(session, dataMode);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const apiRef = useRef(api);
  apiRef.current = api;
  const gate = useRef(null);
  if (!gate.current) gate.current = createMemberInviteGate();
  const [form, setForm] = useState({ email: '', roleCode: 'scout' });
  const [secret, setSecret] = useState(null);
  const [snapshot, setSnapshot] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  // Render-time fence: never show the prior account's invite emails or
  // one-time token even between the render and effect cleanup.
  const visibleSecret = secret?.scope === scope && secret?.api === api ? secret : null;
  const visibleList = snapshot?.scope === scope && snapshot?.api === api ? snapshot : null;
  const rows = visibleList?.rows || [];
  const requestIsCurrent = (requestScope, requestApi) => Boolean(requestScope &&
    scopeRef.current === requestScope && apiRef.current === requestApi);

  useEffect(() => {
    let active = true;
    const requestScope = scope;
    const requestApi = api;
    gate.current.release();
    setBusy(false);
    setSecret(null);
    setError('');
    setSnapshot({ scope: requestScope, api: requestApi, rows: [], loading: Boolean(requestScope) });
    if (requestScope) {
      void (async () => {
        try {
          const response = await requestApi.memberInvitations();
          const list = checkedMemberInvitations(response);
          if (active && requestIsCurrent(requestScope, requestApi)) {
            setSnapshot({ scope: requestScope, api: requestApi, rows: list, loading: false });
          }
        } catch (err) {
          if (active && requestIsCurrent(requestScope, requestApi)) {
            setSnapshot({ scope: requestScope, api: requestApi, rows: [], loading: false,
              error: err?.message || 'No se pudo cargar las invitaciones.' });
          }
        }
      })();
    }
    return () => { active = false; gate.current.release(); };
  }, [scope, api, revision]);

  const submit = async (event) => {
    event.preventDefault();
    let prepared;
    try { prepared = prepareMemberInvitation(form, session, dataMode); }
    catch (err) { setError(err.message); return; }
    if (!gate.current.acquire()) return;
    const requestScope = scope;
    const requestApi = api;
    setBusy(true);
    setError('');
    setSecret(null);
    try {
      const response = await requestApi.createMemberInvitation(prepared.body);
      if (!requestIsCurrent(requestScope, requestApi)) return;
      const confirmed = confirmMemberInvitation(response, prepared);
      if (!requestIsCurrent(requestScope, requestApi)) return;
      setSecret({ scope: requestScope, api: requestApi, ...confirmed });
      setForm({ email: '', roleCode: 'scout' });
      setRevision(value => value + 1);
    } catch (err) {
      if (requestIsCurrent(requestScope, requestApi)) {
        setError('La creación no quedó confirmada. Revisá la lista antes de volver a invitar. ' +
          (err?.message || 'Sin respuesta del servidor.'));
        setRevision(value => value + 1);
      }
    } finally {
      if (requestIsCurrent(requestScope, requestApi)) {
        gate.current.release();
        setBusy(false);
      }
    }
  };

  const revoke = async (id) => {
    if (!rows.some(row => row.id === id && row.status === 'pending')) return;
    if (!window.confirm('¿Revocar esta invitación? El código dejará de funcionar.')) return;
    if (!gate.current.acquire()) return;
    const requestScope = scope;
    const requestApi = api;
    setBusy(true);
    setError('');
    try {
      await requestApi.revokeMemberInvitation(id);
      if (requestIsCurrent(requestScope, requestApi)) {
        setSecret(null);
        setRevision(value => value + 1);
      }
    } catch (err) {
      if (requestIsCurrent(requestScope, requestApi)) {
        setError(err?.message || 'No se pudo confirmar la revocación.');
        setRevision(value => value + 1);
      }
    } finally {
      if (requestIsCurrent(requestScope, requestApi)) {
        gate.current.release(); setBusy(false);
      }
    }
  };

  if (!scope) return null;

  return (
    <section className="team-section" aria-label="Invitaciones a esta empresa">
      <div className="team-section__header">
        <UserPlus size={17} aria-hidden="true" />
        <h2>Invitar colaboradores</h2>
      </div>
      <p>Generá una invitación segura válida por siete días. SedeAgro todavía no envía emails:
        deberás compartir el código una sola vez por un canal privado con su destinatario.
        Nunca lo publiques en un grupo o incidencia.</p>
      <form onSubmit={submit} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
        <label className="form-field" style={{ flex: '1 1 230px' }}>
          Email del destinatario
          <input type="email" value={form.email} required autoComplete="off"
            onChange={event => setForm(previous => ({ ...previous, email: event.target.value }))}
            disabled={busy} placeholder="monitoreador@empresa.com" maxLength={320} />
        </label>
        <label className="form-field" style={{ flex: '1 1 160px' }}>
          Permisos
          <select value={form.roleCode} disabled={busy}
            onChange={event => setForm(previous => ({ ...previous, roleCode: event.target.value }))}>
            {MEMBER_INVITE_ROLES.map(role => <option key={role} value={role}>{ROLE_NAMES[role]}</option>)}
          </select>
        </label>
        <button type="submit" className="primary-action" disabled={busy} aria-busy={busy}>
          <UserPlus size={15} aria-hidden="true" /> {busy ? 'Guardando…' : 'Generar invitación'}
        </button>
      </form>

      {error && <p role="alert" className="resource-error">{error}</p>}
      {visibleSecret && <div role="status" className="resource-demo-note" style={{ overflowWrap: 'anywhere' }}>
        <strong>Invitación generada (todavía no enviada)</strong>
        <p>Para {visibleSecret.invitation.email}. Compartí este código de forma privada.
          Se mostrará solo en esta pantalla hasta que la cierres o cambies de sesión.</p>
        <code style={{ display: 'block', wordBreak: 'break-all', padding: '8px 0' }}>{visibleSecret.secret}</code>
        <button type="button" className="ghost-action" onClick={async () => {
          try { await navigator.clipboard.writeText(visibleSecret.secret); }
          catch { setError('El portapapeles no está disponible. Seleccioná y copiá el código manualmente.'); }
        }}>Copiar código</button>
        <button type="button" className="ghost-action" onClick={() => setSecret(null)}>
          Ocultar código
        </button>
        <p>El destinatario debe abrir «Tengo una invitación» desde el ingreso e introducir
          el código allí. El código no activa la cuenta sin elegir o verificar su contraseña.</p>
      </div>}

      <h3>Invitaciones registradas</h3>
      {visibleList?.loading && <p role="status">Consultando invitaciones…</p>}
      {visibleList?.error && <p role="alert" className="resource-error">{visibleList.error}
        <button type="button" className="ghost-action" onClick={() => setRevision(v => v + 1)}>
          Reintentar consulta
        </button>
      </p>}
      {!visibleList?.loading && !visibleList?.error && (
        rows.length === 0 ? <p>No hay invitaciones registradas.</p> :
          <div className="member-grid">
            {rows.map(row => {
              const expired = row.status === 'pending' && Date.parse(row.expiresAt) <= Date.now();
              return <article className="member-card" key={row.id}>
                <div className="member-card__info">
                  <strong>{row.email}</strong>
                  <p>{ROLE_NAMES[row.roleCode] || row.roleCode}</p>
                  <small>{expired ? 'Vencida' : row.status === 'pending' ? 'Pendiente de aceptación' :
                    row.status === 'accepted' ? 'Aceptada' : 'Revocada'} ·
                    Vence {new Date(row.expiresAt).toLocaleDateString('es-AR')}</small>
                </div>
                {row.status === 'pending' && !expired &&
                  <button type="button" className="ghost-action" disabled={busy}
                    onClick={() => revoke(row.id)}>Revocar</button>}
              </article>;
            })}
          </div>
      )}
      <p><Mail size={13} aria-hidden="true" /> La invitación no acredita entrega ni lectura.
        La membresía será activa únicamente después de aceptarla.</p>
    </section>
  );
}
