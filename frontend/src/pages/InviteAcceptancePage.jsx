import { useEffect, useRef, useState } from 'react';
import { Leaf } from 'lucide-react';
import { API_URL } from '../services/api.js';
import { confirmMemberActivation, createMemberInviteGate } from '../services/memberInvitationSafety.js';

// No token is read from URLs, cookies, localStorage or sessionStorage.
// Recipients paste the one-time code given to them through a private channel.
export function InviteAcceptancePage({ onSwitchToLogin }) {
  const [form, setForm] = useState({ token: '', fullName: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(null);
  const gate = useRef(null);
  if (!gate.current) gate.current = createMemberInviteGate();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; gate.current.release(); };
  }, []);

  const submit = async (event) => {
    event.preventDefault();
    if (!gate.current.acquire()) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(API_URL + '/auth/invite/accept', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-sedeagro-request': '1' },
        credentials: 'omit',
        cache: 'no-store',
        body: JSON.stringify({
          token: form.token.trim(), password: form.password,
          ...(form.fullName.trim() ? { fullName: form.fullName.trim() } : {})
        })
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(result?.error?.message || 'No se pudo aceptar la invitación.');
      }
      const confirmed = confirmMemberActivation(result, form.token.trim());
      if (alive.current) {
        setForm({ token: '', fullName: '', password: '' });
        setSuccess(confirmed);
      }
    } catch (err) {
      if (alive.current) setError(err?.message || 'No se pudo contactar con el servidor.');
    } finally {
      if (alive.current) { gate.current.release(); setBusy(false); }
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="brand" style={{ justifyContent: 'center', marginBottom: 24 }}>
          <span className="brand__mark"><Leaf size={20} /></span>
          <span className="brand__name">SedeAgro</span>
        </div>
        <h1>Aceptar invitación</h1>
        {success ? (
          <div role="status">
            <p>Tu acceso a <strong>{success.tenantName}</strong> se activó.
              Ya podés iniciar sesión con tu email y contraseña.</p>
            <button type="button" className="primary-action" onClick={onSwitchToLogin}>
              Ir a iniciar sesión
            </button>
          </div>
        ) : (
          <>
            <p>Ingresá el código que te compartió el administrador de tu empresa.
              No necesitás abrir enlaces con códigos en la URL.</p>
            <form onSubmit={submit} style={{ display: 'grid', gap: 14 }}>
              <label className="form-field">
                Código privado de invitación
                <textarea required value={form.token} rows={3} disabled={busy}
                  autoComplete="off" spellCheck={false}
                  onChange={e => setForm(previous => ({ ...previous, token: e.target.value }))}
                  placeholder="Pegá el código que te enviaron en privado" />
              </label>
              <label className="form-field">
                Nombre completo (solo si todavía no tenés cuenta)
                <input value={form.fullName} disabled={busy} autoComplete="name" maxLength={180}
                  onChange={e => setForm(previous => ({ ...previous, fullName: e.target.value }))} />
              </label>
              <label className="form-field">
                {form.fullName ? 'Elegí tu contraseña (mínimo 12 caracteres)' : 'Tu contraseña o una nueva si es tu primera cuenta'}
                <input type="password" value={form.password} required disabled={busy}
                  autoComplete="new-password"
                  onChange={e => setForm(previous => ({ ...previous, password: e.target.value }))} />
              </label>
              <small>Si ya tenés una cuenta SedeAgro, ingresá tu contraseña existente.
                Una invitación nunca cambia tu contraseña.</small>
              {error && <div className="auth-error" role="alert">{error}</div>}
              <button type="submit" className="primary-action" disabled={busy} aria-busy={busy}>
                {busy ? 'Verificando…' : 'Activar mi acceso'}
              </button>
            </form>
            <button type="button" className="ghost-action"
              disabled={busy} style={{ marginTop: 16, width: '100%', justifyContent: 'center' }}
              onClick={onSwitchToLogin}>Volver a iniciar sesión</button>
          </>
        )}
      </div>
    </div>
  );
}
