import { useEffect, useRef, useState } from 'react';
import { useSession } from '../context/SessionContext.jsx';
import { Modal } from './Modal.jsx';
import { offlineQueue } from '../services/offlineQueue.js';
import { cameraPhotoPlan, readOfflinePhoto } from '../services/offlinePhoto.js';
import { ObservationLocationPicker } from './ObservationLocationPicker.jsx';
import { sessionScope } from '../services/offlineSyncModel.js';
import { localObservationDateTime } from '../services/observationLocation.js';
import { createMobileCaptureFence } from '../services/mobileCaptureSafety.js';

const emptyObservation = () => ({
  observation_type: 'weed',
  severity: 'medium',
  observed_at: localObservationDateTime(),
  notes: ''
});

export function ObservationFormModal({ isOpen, onClose, onCreated, onQueued, runId }) {
  const { dataMode, session } = useSession();
  const [form, setForm] = useState(emptyObservation);
  const [saving, setSaving] = useState(false);
  const [photo, setPhoto] = useState(null);
  const [photoPreview, setPhotoPreview] = useState(null);
  const [photoError, setPhotoError] = useState('');
  const [location, setLocation] = useState(null);
  const [locating, setLocating] = useState(false);
  const locationKey = `${dataMode}:${sessionScope(session) || 'anonymous'}:${runId}`;
  const captureFence = useRef(null);
  if (!captureFence.current) captureFence.current = createMobileCaptureFence();
  // Render-time fence: asynchronous JPEG decoding can finish before an effect
  // runs after a tenant/run change. Do not use a stale closure to persist.
  captureFence.current.setScope(isOpen && dataMode === 'live' ? locationKey : null);
  useEffect(() => () => captureFence.current.invalidate(), []);
  const selectedLocation = location?.key === locationKey ? location.fix : null;
  const [error, setError] = useState('');

  // Cancelled/finished forms and actor/tenant/run changes must never reuse
  // a previous operator's private notes, photo or explicitly approved GPS.
  useEffect(() => {
    setForm(emptyObservation());
    setLocation(null);
    setLocating(false);
    setPhoto(null);
    setPhotoError('');
    setError('');
  }, [isOpen, locationKey]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  useEffect(() => {
    if (!photo) {
      setPhotoPreview(null);
      return undefined;
    }
    const url = URL.createObjectURL(photo);
    setPhotoPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  const onPhotoSelected = (event) => {
    const selected = event.target.files?.[0] || null;
    // Reset inputs so selecting the same photo again fires a change event.
    event.target.value = '';
    setPhotoError('');
    if (!selected) return;
    try {
      cameraPhotoPlan(selected);
      setPhoto(selected);
    } catch (err) {
      setPhoto(null);
      setPhotoError(err?.message || 'No se pudo seleccionar esta fotografía.');
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const ticket = captureFence.current.ticket();
    if (!captureFence.current.isCurrent(ticket)) return;
    setSaving(true);
    setError('');
    try {
      if (dataMode !== 'live') {
        setError('El modo demo no guarda observaciones. Conectá el backend para continuar.');
        return;
      }
      if (locating) throw new Error('Esperá que termine la consulta GPS antes de guardar.');
      // Persist before telling the user the operation was saved. Background
      // delivery runs through the idempotent batch API, even when online.
      const attachment = photo ? await readOfflinePhoto(photo) : null;
      if (!captureFence.current.isCurrent(ticket)) return;
      const item = await offlineQueue.queueObservation(session, runId, {
        ...form,
        ...(selectedLocation ? { point: selectedLocation.point } : {}),
        ...(attachment ? { photo: attachment } : {})
      });
      if (captureFence.current.isCurrent(ticket)) onQueued?.(item);
    } catch (err) {
      if (captureFence.current.isCurrent(ticket)) {
        setError(err?.message || 'Error al guardar');
      }
    } finally {
      if (captureFence.current.isCurrent(ticket)) setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Agregar observación"
      footer={<>
        <button type="button" className="ghost-action" onClick={onClose} disabled={saving}>Cancelar</button>
        <button type="submit" form="obs-form" className="primary-action" disabled={saving || locating}>
          {saving ? 'Preparando y guardando…' : 'Guardar observación'}
        </button>
      </>}
    >
      <form id="obs-form" onSubmit={handleSubmit} style={{ display: 'contents' }}>
        {error && <div className="auth-error" style={{ marginBottom: 0 }}><span>{error}</span></div>}

        <div className="form-row">
          <label className="form-field">
            <span>Tipo de observación *</span>
            <select id="obs-type" value={form.observation_type} onChange={set('observation_type')}>
              <option value="weed">Maleza</option>
              <option value="pest">Plaga</option>
              <option value="disease">Enfermedad</option>
              <option value="phenology">Fenología</option>
              <option value="nutrition">Nutrición</option>
              <option value="water">Agua</option>
              <option value="general">General</option>
            </select>
          </label>
          <label className="form-field">
            <span>Severidad *</span>
            <select id="obs-severity" value={form.severity} onChange={set('severity')}>
              <option value="low">Leve</option>
              <option value="medium">Moderado</option>
              <option value="high">Alto</option>
              <option value="critical">Crítico</option>
            </select>
          </label>
        </div>

        <label className="form-field">
          <span>Fecha / hora de observación</span>
          <input id="obs-date" type="datetime-local" value={form.observed_at} onChange={set('observed_at')} />
        </label>

        <p style={{ color: '#64748b', fontSize: 12, margin: 0 }}>
          La observación se guarda primero en este dispositivo y se enviará con una clave
          de reintento segura cuando haya conexión. No se considera registrada en el servidor
          hasta aparecer como «Aplicada» en Sincronizaciones.
        </p>
        <ObservationLocationPicker key={locationKey}
          location={selectedLocation}
          disabled={saving || dataMode !== 'live'}
          onBusyChange={setLocating}
          onChange={(fix) => setLocation(fix ? { key: locationKey, fix } : null)}
        />
        <div className="field-photo-picker">
          <strong style={{ fontSize: 13 }}>Fotografía opcional</strong>
          <div className="field-photo-picker__actions">
            <label className="ghost-action field-photo-picker__action">
              Tomar foto
              <input type="file" accept="image/jpeg,image/png,image/webp" capture="environment"
                onChange={onPhotoSelected} disabled={saving} aria-label="Tomar foto con cámara trasera" />
            </label>
            <label className="ghost-action field-photo-picker__action">
              Elegir archivo
              <input type="file" accept="image/jpeg,image/png,image/webp"
                onChange={onPhotoSelected} disabled={saving} aria-label="Elegir fotografía del dispositivo" />
            </label>
            {photo && <button type="button" className="ghost-action" disabled={saving}
              onClick={() => setPhoto(null)}>Quitar foto</button>}
          </div>
          {photo && (
            <div className="field-photo-picker__selected">
              {photoPreview && <img src={photoPreview} alt="Vista previa local de la fotografía seleccionada" />}
              <div>
                <strong>{photo.name}</strong>
                <div>{(photo.size / 1048576).toFixed(2)} MiB originales</div>
                <div>{photo.size > 512 * 1024
                  ? 'Se reducirá y limpiará antes de guardar (máximo 512 KiB).'
                  : 'Se convertirá a JPEG para quitar metadatos de ubicación y del dispositivo.'}</div>
              </div>
            </div>
          )}
          {photoError && <p role="alert" className="field-photo-picker__error">{photoError}</p>}
          <p className="field-photo-picker__hint">
            JPEG, PNG o WebP de hasta 12 MiB. Las fotos grandes se convierten a JPEG
            de hasta 512 KiB para guardarlas cifradas. Todas las fotos nuevas se convierten
            a JPEG para eliminar metadatos EXIF/GPS del archivo original, incluso las pequeñas.
            Esto puede modificar la calidad y la transparencia.
          </p>
        </div>
        <label className="form-field">
          <span>Notas *</span>
          <textarea id="obs-notes" value={form.notes} onChange={set('notes')} required rows={3}
            placeholder="Descripción de lo observado en el lote…" />
        </label>
      </form>
    </Modal>
  );
}
