import { useState } from 'react';
import { Leaf, AlertCircle, Eye, EyeOff } from 'lucide-react';
import { API_URL } from '../services/api.js';
import { useSession } from '../context/SessionContext.jsx';

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

  const set = (key) => (e) => {
    let value = e.target.value;
    if (key === 'slug') value = value.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
    if (key === 'organizationName' && !form.slug) {
      const autoSlug = value.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 40);
      setForm((f) => ({ ...f, [key]: value, slug: autoSlug }));
      return;
    }
    setForm((f) => ({ ...f, [key]: value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API_URL}/auth/register-tenant`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...form, planCode: 'starter' })
      });
      const data = await res.json();
      if (!res.ok) {
        const msg = data.error?.details
          ? Object.values(data.error.details).flat().join('. ')
          : data.error?.message || 'Error al registrar.';
        setError(msg);
        return;
      }
      login(data);
    } catch {
      setError('No se pudo conectar al servidor.');
    } finally {
      setLoading(false);
    }
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
              required
              minLength={12}
              autoComplete="new-password"
              style={{ paddingRight: 44 }}
            />
            <button
              type="button"
              className="auth-eye-btn"
              onClick={() => setShowPassword((v) => !v)}
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
            disabled={loading}
            style={{ marginTop: 8 }}
          >
            {loading ? 'Creando cuenta…' : 'Crear cuenta'}
          </button>
        </form>

        <div className="auth-divider"><span>o</span></div>

        <button type="button" className="ghost-action" style={{ width: '100%', justifyContent: 'center' }} onClick={onSwitchToLogin}>
          Ya tengo cuenta — Ingresar
        </button>
      </div>
    </div>
  );
}
