import { useState } from 'react';
import { Leaf, Eye, EyeOff, AlertCircle } from 'lucide-react';
import { API_URL } from '../services/api.js';
import { useSession } from '../context/SessionContext.jsx';

export function LoginPage({ onSwitchToRegister }) {
  const { login } = useSession();
  const [form, setForm] = useState({ email: '', password: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [tenantChoices, setTenantChoices] = useState(null);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const doLogin = async (body) => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error?.message || 'Email o contraseña incorrectos.');
        return;
      }
      if (data.requiresTenantSelection) {
        setTenantChoices(data.memberships);
        return;
      }
      login(data);
    } catch {
      setError('No se pudo conectar al servidor.');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    doLogin({ email: form.email, password: form.password });
  };

  const handleTenantSelect = (tenantSlug) => {
    doLogin({ email: form.email, password: form.password, tenantSlug });
  };

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
                  style={{ paddingRight: 44 }}
                />
                <button
                  type="button"
                  className="auth-eye-btn"
                  onClick={() => setShowPassword((v) => !v)}
                  tabIndex={-1}
                  aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </label>

              <button
                id="login-submit"
                type="submit"
                className="primary-action"
                disabled={loading}
                style={{ marginTop: 8 }}
              >
                {loading ? 'Ingresando…' : 'Ingresar'}
              </button>
            </form>

            <div className="auth-divider"><span>o</span></div>

            <button type="button" className="ghost-action" style={{ width: '100%', justifyContent: 'center' }} onClick={onSwitchToRegister}>
              Crear cuenta nueva
            </button>
          </>
        ) : (
          /* Tenant Selection */
          <>
            <div style={{ textAlign: 'center', marginBottom: 24 }}>
              <h1 style={{ fontSize: 20, fontWeight: 800, marginBottom: 6 }}>Elegí tu empresa</h1>
              <p style={{ color: '#64748b', fontSize: 14 }}>Tu usuario tiene acceso a varias organizaciones</p>
            </div>
            <div style={{ display: 'grid', gap: 10 }}>
              {tenantChoices.map((m) => (
                <button
                  key={m.tenantId}
                  type="button"
                  className="tenant-choice-btn"
                  onClick={() => handleTenantSelect(m.tenantSlug)}
                >
                  <span className="tenant-choice-btn__name">{m.tenantName}</span>
                  <span className="tenant-choice-btn__role">{m.roleCode}</span>
                </button>
              ))}
            </div>
            <button type="button" style={{ marginTop: 20, background: 'none', border: 'none', cursor: 'pointer', color: '#64748b', fontSize: 13 }} onClick={() => setTenantChoices(null)}>
              ← Volver
            </button>
          </>
        )}
      </div>
    </div>
  );
}
