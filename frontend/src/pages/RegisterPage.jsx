import { useEffect, useRef, useState } from 'react';
import { Leaf, AlertCircle, Eye, EyeOff } from 'lucide-react';
import { API_URL } from '../services/api.js';
import { useSession } from '../context/SessionContext.jsx';
import { createCompanyRegistrationGate, verifyRegisteredCompany } from '../services/companyRegistrationSafety.js';

export function RegisterPage({ onSwitchToLogin }) {
  const { login } = useSession();
  const [form, setForm] = useState({
    organizationName: '',
    slug: '',
    fullName: '',
    email: '',
    password: ''
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const gate = useRef(null);
  if (!gate.current) gate.current = createCompanyRegistrationGate();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; gate.current.reset(); };
  }, []);
  const blocked = loading || gate.current.isBlocked();


  const set = (key) => (e) => {
    if (gate.current.isBlocked()) return;
    let value = e.target.value;
    if (key === 'slug') value = value.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
    if (key === 'organizationName' && !form.slug) {
      const autoSlug = value.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 40);
      setForm((f) => ({ ...f, [key]: value, slug: autoSlug }));
      return;
    }
    setForm((f) => ({ ...f, [key]: value }));
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    let ticket;
    try {
      ticket = gate.current.acquire(form);
    } catch (err) {
      setError(err?.message || 'Revisá los datos de la empresa.');
      return;
    }
    if (!ticket) return; // synchronous one-shot barrier, before React rerender
    setLoading(true);
    setError('');
    void (async () => {
      try {
        const res = await fetch(API_URL + '/auth/register-tenant', {
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
          const message = typeof data?.error?.message === 'string'
            ? data.error.message : 'No se pudo registrar la empresa.';
          const err = new Error(message);
          err.status = res.status;
          throw err;
        }
        if (!alive.current || !gate.current.isCurrent(ticket)) return;
        const session = verifyRegisteredCompany(data, ticket.body);
        gate.current.finish(ticket, 'confirmed');
        login(session);
      } catch (err) {
        if (!alive.current || !gate.current.isCurrent(ticket)) return;
        // Known validation/conflict/rate-limit replies reject the operation.
        // Timeouts, 5xx and inconsistent success ACKs can follow COMMIT.
        if ([400, 401, 403, 409, 422, 429].includes(err?.status)) {
          gate.current.finish(ticket, 'rejected');
          setError(err?.message || 'Revisá los datos e intentá nuevamente.');
        } else {
          gate.current.finish(ticket, 'uncertain');
          setError('No pudimos confirmar si la empresa se creó. No vuelvas a enviarla todavía: probá ingresar con esta cuenta y revisá el resultado.');
        }
      } finally {
        if (alive.current) setLoading(false);
      }
    })();
  };

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="brand" style={{ justifyContent: 'center', marginBottom: 28 }}>
          <span className="brand__mark"><Leaf size={20} /></span>
          <span className="brand__name">SedeAgro</span>
        </div>

        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: -0.5, marginBottom: 6 }}>
            Crear cuenta
          </h1>
          <p style={{ color: '#64748b', fontSize: 14 }}>
            Creá tu empresa en SedeAgro en minutos
          </p>
        </div>

        {error && (
          <div className="auth-error">
            <AlertCircle size={16} />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: 'grid', gap: 14 }}>
          <label className="form-field">
            <span>Nombre de la organización</span>
            <input
              id="reg-org-name"
              type="text"
              placeholder="Agro Norte SRL"
              value={form.organizationName}
              onChange={set('organizationName')}
              disabled={blocked}
              required
              minLength={2}
            />
          </label>

          <label className="form-field">
            <span>Identificador único (slug)</span>
            <input
              id="reg-slug"
              type="text"
              placeholder="agro-norte"
              value={form.slug}
              onChange={set('slug')}
              disabled={blocked}
              required
              minLength={3}
              maxLength={40}
            />
          </label>

          <div className="form-row">
            <label className="form-field">
              <span>Nombre completo</span>
              <input
                id="reg-full-name"
                type="text"
                placeholder="Juan García"
                value={form.fullName}
                onChange={set('fullName')}
              disabled={blocked}
                required
                minLength={2}
              />
            </label>
            <label className="form-field">
              <span>Email</span>
              <input
                id="reg-email"
                type="email"
                placeholder="juan@empresa.com"
                value={form.email}
                onChange={set('email')}
              disabled={blocked}
                required
                autoComplete="email"
              />
            </label>
          </div>

          <label className="form-field" style={{ position: 'relative' }}>
            <span>Contraseña (mín. 12 caracteres)</span>
            <input
              id="reg-password"
              type={showPassword ? 'text' : 'password'}
              placeholder="••••••••••••"
              value={form.password}
              onChange={set('password')}
              disabled={blocked}
              required
              minLength={12}
              autoComplete="new-password"
              style={{ paddingRight: 44 }}
            />
            <button
              type="button"
              className="auth-eye-btn"
              onClick={() => setShowPassword((v) => !v)}
              disabled={blocked}
              tabIndex={-1}
              aria-label="Mostrar contraseña"
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </label>

          <button
            id="register-submit"
            type="submit"
            className="primary-action"
            disabled={blocked}
            style={{ marginTop: 8 }}
          >
            {loading ? 'Creando cuenta…' : 'Crear cuenta'}
          </button>
        </form>

        <div className="auth-divider"><span>o</span></div>

        <button type="button" className="ghost-action" style={{ width: '100%', justifyContent: 'center' }} onClick={onSwitchToLogin} disabled={loading}>
          Ya tengo cuenta — Ingresar
        </button>
      </div>
    </div>
  );
}
