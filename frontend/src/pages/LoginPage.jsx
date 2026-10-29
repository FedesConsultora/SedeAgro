import { useEffect, useRef, useState } from 'react';
import { Leaf, Eye, EyeOff, AlertCircle } from 'lucide-react';
import { API_URL } from '../services/api.js';
import { useSession } from '../context/SessionContext.jsx';
import { createLoginAttemptGate } from '../services/loginAttemptSafety.js';

export function LoginPage({ onSwitchToRegister, onSwitchToInvite }) {
  const { login } = useSession();
  const [form, setForm] = useState({ email: '', password: '', tenantSlug: '' });
  const [showTenantSlug, setShowTenantSlug] = useState(false);
  const [capacityHint, setCapacityHint] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [tenantChoices, setTenantChoices] = useState(null);

  const gate = useRef(null);
  if (!gate.current) gate.current = createLoginAttemptGate();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; gate.current.reset(); };
  }, []);

  const set = (key) => (event) => {
    if (gate.current.phase() !== 'idle') return;
    const value = event.target.value;
    setForm(previous => ({ ...previous, [key]: value }));
  };

  const doLogin = async (ticket) => {
    if (!ticket) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch(API_URL + '/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          'x-sedeagro-session': 'cookie',
          'x-sedeagro-request': '1'
        },
        body: JSON.stringify(ticket.body)
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const error = new Error(typeof data?.error?.message === 'string'
          ? data.error.message : 'No se pudo iniciar sesión.');
        error.status = res.status;
        error.code = data?.error?.code;
        throw error;
      }
      if (!alive.current || !gate.current.isCurrent(ticket)) return;
      const next = gate.current.complete(ticket, data);
      if (next?.kind === 'choices') setTenantChoices(next.memberships);
      else if (next?.kind === 'session') login(next.session);
    } catch (err) {
      if (!alive.current || !gate.current.isCurrent(ticket)) return;
      gate.current.fail(ticket);
      // An expired/forbidden second challenge must not keep old membership
      // names or the original credential pair eligible for another request.
      if (err?.status === 503 && err?.code === 'LOGIN_DISCOVERY_CAPACITY_LIMIT' &&
          ticket.kind === 'initial' && !ticket.body.tenantSlug) {
        // A password-verified selectorless scan exceeded its bounded tenant
        // catalog. Let the operator opt into an O(1) slug lookup instead of
        // retrying the same expensive public tenant enumeration.
        setShowTenantSlug(true);
        setCapacityHint(true);
        setForm(previous => ({ ...previous, password: '' }));
        setError('Hay muchas organizaciones registradas. Ingresá el identificador de tu empresa y volvé a escribir tu contraseña.');
      } else {
        // An expired/forbidden second challenge must not keep old membership
        // names or the original credential pair eligible for another request.
        if (ticket.kind === 'selected' && [401, 403].includes(err?.status)) {
          gate.current.reset();
          setTenantChoices(null);
          setForm(previous => ({ ...previous, password: '' }));
        }
        setError(err?.message || 'No se pudo conectar al servidor.');
      }
    } finally {
      if (alive.current) setLoading(false);
    }
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    let ticket;
    try {
      ticket = gate.current.begin(form);
    } catch (err) {
      setError(err?.message || 'Revisá el email y la contraseña.');
      return;
    }
    if (ticket) void doLogin(ticket);
  };

  const handleTenantSelect = (slug) => {
    const ticket = gate.current.choose(slug);
    if (ticket) void doLogin(ticket);
  };

  const handleBack = () => {
    if (gate.current.busy()) return;
    gate.current.reset();
    setTenantChoices(null);
    setForm(previous => ({ ...previous, password: '' }));
    setCapacityHint(false);
    setError('');
  };

  const locked = loading || gate.current.busy();

  return (
    <div className="auth-shell">
      <div className="auth-card">
        {/* Brand */}
        <div className="brand" style={{ justifyContent: 'center', marginBottom: 32 }}>
          <span className="brand__mark"><Leaf size={20} /></span>
          <span className="brand__name">SedeAgro</span>
        </div>

        {!tenantChoices ? (
          <>
            <div style={{ textAlign: 'center', marginBottom: 28 }}>
              <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: -0.5, marginBottom: 6 }}>
                Iniciar sesión
              </h1>
              <p style={{ color: '#64748b', fontSize: 14 }}>
                Ingresá a tu espacio de trabajo agronómico
              </p>
            </div>

            {error && (
              <div className="auth-error">
                <AlertCircle size={16} />
                <span>{error}</span>
              </div>
            )}

            <form onSubmit={handleSubmit} style={{ display: 'grid', gap: 16 }}>
              <label className="form-field">
                <span>Email</span>
                <input
                  id="login-email"
                  type="email"
                  placeholder="tu@empresa.com"
                  value={form.email}
                  onChange={set('email')}
                  required
                  autoComplete="email"
                  autoFocus
                  disabled={locked}
                />
              </label>

              <label className="form-field" style={{ position: 'relative' }}>
                <span>Contraseña</span>
                <input
                  id="login-password"
                  type={showPassword ? 'text' : 'password'}
                  placeholder="••••••••••••"
                  value={form.password}
                  onChange={set('password')}
                  required
                  autoComplete="current-password"
                  disabled={locked}
                  style={{ paddingRight: 44 }}
                />
                <button
                  type="button"
                  className="auth-eye-btn"
                  onClick={() => setShowPassword((v) => !v)}
                  disabled={locked}
                  tabIndex={-1}
                  aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </label>

              <div>
                <button type="button" className="ghost-action"
                  aria-expanded={showTenantSlug}
                  aria-controls="login-company-slug"
                  disabled={locked}
                  onClick={() => {
                    if (locked) return;
                    setShowTenantSlug(previous => !previous);
                    setCapacityHint(false);
                    setError('');
                    setForm(previous => ({ ...previous, tenantSlug: '' }));
                  }}>
                  {showTenantSlug ? 'Usar selección automática de empresa' : 'Ingresar con identificador de empresa'}
                </button>
                {showTenantSlug && (
                  <label className="form-field" id="login-company-slug"
                    style={{ marginTop: 10 }}>
                    <span>Identificador de empresa (slug)</span>
                    <input
                      id="login-tenant-slug"
                      type="text"
                      value={form.tenantSlug}
                      onChange={set('tenantSlug')}
                      placeholder="ejemplo-agro"
                      autoCapitalize="none"
                      autoComplete="off"
                      spellCheck={false}
                      pattern="[a-zA-Z0-9-]{3,90}"
                      minLength={3}
                      maxLength={90}
                      required
                      disabled={locked}
                    />
                    <small>Se encuentra en los datos de tu empresa.
                      Sólo determina qué organización consultar; no reemplaza
                      la verificación de usuario, contraseña ni permisos.</small>
                    {capacityHint && <small role="status">
                      El acceso automático superó el límite de organizaciones.
                      El acceso directo consulta una sola empresa.
                    </small>}
                  </label>
                )}
              </div>

              <button
                id="login-submit"
                type="submit"
                className="primary-action"
                disabled={locked}
                style={{ marginTop: 8 }}
              >
                {loading ? 'Ingresando…' : 'Ingresar'}
              </button>
            </form>

            <div className="auth-divider"><span>o</span></div>

            <button type="button" className="ghost-action" style={{ width: '100%', justifyContent: 'center' }} onClick={onSwitchToRegister} disabled={locked}>
              Crear cuenta nueva
            </button>
            <button type="button" className="ghost-action" style={{ width: '100%', justifyContent: 'center', marginTop: 10 }}
              onClick={onSwitchToInvite} disabled={locked}>
              Tengo una invitación
            </button>
          </>
        ) : (
          /* Tenant Selection */
          <>
            <div style={{ textAlign: 'center', marginBottom: 24 }}>
              <h1 style={{ fontSize: 20, fontWeight: 800, marginBottom: 6 }}>Elegí tu empresa</h1>
              <p style={{ color: '#64748b', fontSize: 14 }}>Tu usuario tiene acceso a varias organizaciones</p>
              {error && <div className="auth-error" role="alert"><AlertCircle size={16} /><span>{error}</span></div>}
            </div>
            <div style={{ display: 'grid', gap: 10 }}>
              {tenantChoices.map((m) => (
                <button
                  key={m.tenantId}
                  type="button"
                  className="tenant-choice-btn"
                  onClick={() => handleTenantSelect(m.tenantSlug)}
                  disabled={locked}
                >
                  <span className="tenant-choice-btn__name">{m.tenantName}</span>
                  <span className="tenant-choice-btn__role">{m.roleCode}</span>
                </button>
              ))}
            </div>
            <button type="button" style={{ marginTop: 20, background: 'none', border: 'none', cursor: 'pointer', color: '#64748b', fontSize: 13 }} onClick={handleBack}>
              ← Volver
            </button>
          </>
        )}
      </div>
    </div>
  );
}
