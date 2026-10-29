import { useEffect, useRef, useState } from 'react';
import {
  cameraPhotoPlan, readOfflinePhoto
} from '../services/offlinePhoto.js';
import {
  clearOfflineFieldVault, enrollOfflineFieldVault, listOfflineFieldDrafts,
  lockOfflineFieldVault, queueOfflineFieldObservation, unlockOfflineFieldVault
} from '../services/offlineFieldVault.js';
import { localObservationDateTime } from '../services/observationLocation.js';
import { ObservationLocationPicker } from './ObservationLocationPicker.jsx';

// Enrollment is allowed only after a FRESH HTTP /auth/me, never using
// tenantHint, an old React view, an offline cookie or remembered user IDs.
export function OfflineFieldSetup({ api, session }) {
  const current = useRef({ api, session });
  current.current = { api, session };
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    setPassphrase(''); setMessage(''); setError('');
  }, [api, session?.tenant?.id, session?.user?.id, session?.membership?.id]);

  const setup = async (event) => {
    event.preventDefault();
    if (busy || navigator.onLine === false) return;
    const expected = current.current;
    setBusy(true); setError(''); setMessage('');
    try {
      const proof = await expected.api.me();
      if (current.current.api !== expected.api ||
          current.current.session !== expected.session) return;
      if (proof?.tenant?.id !== expected.session?.tenant?.id ||
          proof?.user?.id !== expected.session?.user?.id ||
          proof?.membership?.id !== expected.session?.membership?.id ||
          proof?.membership?.roleCode !== expected.session?.membership?.roleCode) {
        throw new Error('La sesión cambió. Revalidá tu cuenta antes de preparar el dispositivo.');
      }
      await enrollOfflineFieldVault({ ...proof, authenticated: true }, passphrase);
      if (current.current.api !== expected.api ||
          current.current.session !== expected.session) {
        await clearOfflineFieldVault();
        return;
      }
      setPassphrase('');
      setMessage('Acceso local preparado para 48 horas. Guardá la frase en un lugar seguro; no queda almacenada.');
    } catch (err) {
      if (current.current.api === expected.api && current.current.session === expected.session) {
        setError(err?.message || 'No se pudo habilitar el acceso local.');
      }
    } finally { setBusy(false); }
  };

  return <section className="card" style={{ padding: 18, marginBottom: 18 }}
    aria-label="Preparar acceso local sin conexión">
    <h2 style={{ fontSize: 16 }}>Preparar recuperación sin conexión</h2>
    <p style={{ fontSize: 13 }}>
      Opcional: antes de salir al campo, verificá tu sesión y elegí una frase local
      de al menos 12 caracteres. Permitirá revisar borradores cifrados y continuar
      recorridas que ya tengan capturas locales tras cerrar el navegador sin red.
      No guarda tu contraseña del servidor ni restaura el inicio de sesión.
    </p>
    <form onSubmit={setup} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <label className="form-field">
        <span>Frase local (no es tu contraseña del servidor)</span>
        <input type="password" minLength={12} maxLength={128} autoComplete="new-password"
          value={passphrase} onChange={event => setPassphrase(event.target.value)}
          required disabled={busy || navigator.onLine === false} />
      </label>
      <button type="submit" className="ghost-action"
        disabled={busy || navigator.onLine === false || passphrase.length < 12}>
        {busy ? 'Verificando y cifrando…' : 'Habilitar acceso offline (48 h)'}
      </button>
    </form>
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    <p style={{ fontSize: 12 }}>
      En un dispositivo compartido, no habilites esta opción. Si se pierde la frase
      o el navegador borra IndexedDB, la recuperación local no es posible.
    </p>
  </section>;
}

const newForm = () => ({
  observation_type: 'general', severity: 'medium',
  observed_at: localObservationDateTime(), notes: ''
});

export function OfflineFieldWorkspace({ onClose }) {
  const [passphrase, setPassphrase] = useState('');
  const [ticket, setTicket] = useState(null);
  const [drafts, setDrafts] = useState([]);
  const [form, setForm] = useState(newForm);
  const [runId, setRunId] = useState('');
  const [photo, setPhoto] = useState(null);
  const [location, setLocation] = useState(null);
  const [locating, setLocating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const live = useRef({ ticket: null, epoch: 0 });
  const lock = () => {
    live.current = { ticket: null, epoch: live.current.epoch + 1 };
    lockOfflineFieldVault();
    setTicket(null); setDrafts([]); setPassphrase(''); setPhoto(null);
    setLocation(null); setRunId(''); setForm(newForm()); setNotice('');
  };
  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState === 'hidden') lock(); };
    const onOnline = () => { lock(); onClose(); };
    const onPagehide = () => lock();
    const onStorage = event => {
      if (event.key === 'sedeagro.auth-transition-v1') { lock(); onClose(); }
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPagehide);
    window.addEventListener('online', onOnline);
    window.addEventListener('storage', onStorage);
    return () => {
      lock();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPagehide);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('storage', onStorage);
    };
  // Locks on any local auth transition/hidden tab, including browser close.
  }, []);

  const unlock = async event => {
    event.preventDefault();
    if (busy || ticket || navigator.onLine !== false) return;
    const epoch = ++live.current.epoch;
    setBusy(true); setError('');
    try {
      const capability = await unlockOfflineFieldVault(passphrase);
      const rows = await listOfflineFieldDrafts(capability);
      if (live.current.epoch !== epoch || navigator.onLine !== false) {
        lockOfflineFieldVault(); return;
      }
      live.current.ticket = capability;
      setTicket(capability); setDrafts(rows); setPassphrase('');
      setRunId(rows[0]?.runId || '');
    } catch (err) {
      if (live.current.epoch === epoch) setError(err?.message || 'No se pudo abrir el acceso local.');
    } finally { if (live.current.epoch === epoch) setBusy(false); }
  };

  const save = async event => {
    event.preventDefault();
    if (!ticket || busy || locating || navigator.onLine !== false || !runId) return;
    const epoch = live.current.epoch;
    setBusy(true); setError(''); setNotice('');
    let stored = false;
    try {
      const attachment = photo ? await readOfflinePhoto(photo) : null;
      if (epoch !== live.current.epoch || live.current.ticket !== ticket) return;
      const row = await queueOfflineFieldObservation(ticket, runId, {
        ...form,
        ...(location ? { point: location.point } : {}),
        ...(attachment ? { photo: attachment } : {})
      });
      stored = true;
      if (epoch !== live.current.epoch || live.current.ticket !== ticket) return;
      setDrafts(await listOfflineFieldDrafts(ticket));
      if (epoch !== live.current.epoch || live.current.ticket !== ticket) return;
      setForm(newForm()); setPhoto(null); setLocation(null);
      setNotice('Observación cifrada en el dispositivo. No se envió al servidor: ' +
        row.idempotencyKey.slice(0, 8) + '…');
    } catch (err) {
      if (epoch === live.current.epoch && live.current.ticket === ticket) {
        setError(stored
          ? 'La captura se guardó, pero la pantalla no pudo actualizarse. No la repitas sin revisar la cola.'
          : err?.message || 'No se guardó la captura.');
      }
    } finally { if (epoch === live.current.epoch) setBusy(false); }
  };

  const availableRuns = [...new Set(drafts.map(item => item.runId))];
  return <div className="auth-shell" style={{ alignItems: 'start' }}>
    <div className="auth-card" style={{ maxWidth: 740, width: '100%' }}>
      <h1>Campo sin conexión</h1>
      <p>Este espacio es **sólo local**. No verifica sesión, permite administrar
        empresas ni envía datos; el servidor revisará tus permisos al reconectar.</p>
      {!ticket ? <form onSubmit={unlock}>
        <label className="form-field">
          <span>Frase de acceso local</span>
          <input type="password" autoComplete="off" value={passphrase}
            minLength={12} maxLength={128} onChange={e => setPassphrase(e.target.value)}
            disabled={busy} required />
        </label>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button type="submit" className="primary-action"
            disabled={busy || passphrase.length < 12 || navigator.onLine !== false}>
            {busy ? 'Descifrando…' : 'Abrir borradores locales'}
          </button>
          <button type="button" className="ghost-action" onClick={onClose}>Volver</button>
        </div>
      </form> : <>
        <p role="status">Acceso local desbloqueado. Se cierra al cambiar de pestaña,
          bloquear la pantalla o recuperar conexión.</p>
        <button type="button" className="ghost-action" onClick={lock}>Bloquear ahora</button>
        <h2 style={{ fontSize: 16 }}>Capturas pendientes ({drafts.length})</h2>
        {drafts.length === 0 ? <p>No existen borradores para esta identidad en este dispositivo.
          Para iniciar otra recorrida necesitás ingresar en línea.</p> :
          <ul>{drafts.map(item => <li key={item.id}>
            <strong>{item.body?.operations?.[0]?.payload?.observation_type || 'Observación'}</strong>
            {' · '}Recorrida {item.runId.slice(0, 8)}…
            {' · '}{item.state === 'pending' ? 'Pendiente' : 'Requiere revisión'}
            <p>{item.body?.operations?.[0]?.payload?.notes}</p>
            {item.evidence && <small>Fotografía cifrada adjunta</small>}
          </li>)}</ul>}
        {availableRuns.length > 0 && <form onSubmit={save} style={{ display: 'grid', gap: 12 }}>
          <h2 style={{ fontSize: 16 }}>Continuar recorrida existente</h2>
          <p>No se cargan recorridas nuevas. Elegí una que ya tenga capturas locales;
            al reconectar, el servidor puede rechazarla si cambió el permiso o el estado.</p>
          <label className="form-field"><span>Recorrida con borradores</span>
            <select value={runId} onChange={e => setRunId(e.target.value)} disabled={busy}>
              {availableRuns.map(id => <option value={id} key={id}>{id}</option>)}
            </select>
          </label>
          <label className="form-field"><span>Tipo</span>
            <select value={form.observation_type} disabled={busy}
              onChange={e => setForm(v => ({ ...v, observation_type: e.target.value }))}>
              {['weed','pest','disease','phenology','nutrition','water','general'].map(id =>
                <option key={id} value={id}>{id}</option>)}
            </select>
          </label>
          <label className="form-field"><span>Severidad</span>
            <select value={form.severity} disabled={busy}
              onChange={e => setForm(v => ({ ...v, severity: e.target.value }))}>
              {['low','medium','high','critical'].map(id => <option key={id} value={id}>{id}</option>)}
            </select>
          </label>
          <label className="form-field"><span>Fecha y hora local</span>
            <input type="datetime-local" value={form.observed_at} disabled={busy}
              onChange={e => setForm(v => ({ ...v, observed_at: e.target.value }))} />
          </label>
          <ObservationLocationPicker location={location} disabled={busy}
            onBusyChange={setLocating} onChange={setLocation} />
          <label className="form-field"><span>Fotografía opcional</span>
            <input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
              capture="environment" disabled={busy} onChange={e => {
                const file = e.target.files?.[0] || null; e.target.value = '';
                if (!file) return;
                try { cameraPhotoPlan(file); setPhoto(file); setError(''); }
                catch (err) { setPhoto(null); setError(err?.message || 'Foto inválida.'); }
              }} />
          </label>
          {photo && <p>Foto lista: {photo.name}. Se convertirá a JPEG sin EXIF antes de cifrar.</p>}
          <label className="form-field"><span>Notas de campo</span>
            <textarea required minLength={1} maxLength={10000} rows={3}
              value={form.notes} disabled={busy}
              onChange={e => setForm(v => ({ ...v, notes: e.target.value }))} />
          </label>
          <button type="submit" className="primary-action"
            disabled={busy || locating || !runId || !form.notes.trim()}>
            {busy ? 'Cifrando…' : 'Guardar sólo en este dispositivo'}
          </button>
        </form>}
      </>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </div>
  </div>;
}
