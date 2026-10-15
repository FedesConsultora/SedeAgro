import { useEffect, useRef, useState } from 'react';
import { LocateFixed, MapPinOff, RotateCcw, X } from 'lucide-react';
import {
  FIELD_GPS_OPTIONS, confirmedFieldLocation, fieldGpsErrorMessage
} from '../services/observationLocation.js';
import './observation-location.css';

// Opt-in one-shot acquisition. We don't use watchPosition and don't store
// GPS permissions, device identifiers or coordinates outside the parent draft.
export function ObservationLocationPicker({ location, onChange, onBusyChange, disabled = false }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestId = useRef(0);
  const pendingRef = useRef(false);
  const callbacksRef = useRef({ onChange, onBusyChange });
  callbacksRef.current = { onChange, onBusyChange };

  useEffect(() => {
    const stopPending = () => {
      if (!pendingRef.current) return;
      // getCurrentPosition has no AbortController. Ignore its eventual late
      // callback (including after mobile browser resumes from sleep).
      requestId.current += 1;
      pendingRef.current = false;
      setLoading(false);
      callbacksRef.current.onBusyChange?.(false);
      callbacksRef.current.onChange(null);
      setError('La consulta GPS se interrumpió al salir de la pantalla. Volvé a solicitarla si querés adjuntar ubicación.');
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') stopPending();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', stopPending);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', stopPending);
      requestId.current += 1;
      pendingRef.current = false;
      callbacksRef.current.onBusyChange?.(false);
    };
  }, []);

  const requestLocation = () => {
    if (disabled || pendingRef.current || document.visibilityState === 'hidden') return;
    setError('');
    onChange(null); // A failed refresh cannot silently keep stale GPS.
    if (typeof navigator === 'undefined' || !navigator.geolocation?.getCurrentPosition) {
      setError('Este dispositivo o navegador no permite consultar la ubicación.');
      return;
    }
    const current = ++requestId.current;
    pendingRef.current = true;
    setLoading(true);
    onBusyChange?.(true);
    try {
      navigator.geolocation.getCurrentPosition(
      position => {
        if (requestId.current !== current) return;
        try {
          onChange(confirmedFieldLocation(position));
          setError('');
        } catch (err) {
          setError(fieldGpsErrorMessage(err));
        } finally {
          pendingRef.current = false;
          setLoading(false);
          onBusyChange?.(false);
        }
      },
      err => {
        if (requestId.current !== current) return;
        setError(fieldGpsErrorMessage(err));
        pendingRef.current = false;
        setLoading(false);
        onBusyChange?.(false);
      },
      FIELD_GPS_OPTIONS
      );
    } catch (err) {
      if (requestId.current === current) {
        pendingRef.current = false;
        setError(fieldGpsErrorMessage(err));
        setLoading(false);
        onBusyChange?.(false);
      }
    }
  };

  return (
    <section className="observation-location" aria-labelledby="obs-location-heading">
      <div className="observation-location__heading">
        <strong id="obs-location-heading">Ubicación GPS opcional</strong>
        <span>Solo bajo tu autorización</span>
      </div>
      <p className="observation-location__help">
        Se consulta la ubicación una sola vez cuando tocás el botón. No rastreamos
        tu recorrido. Si la adjuntás, se cifra junto a la observación pendiente en
        este dispositivo y se enviará al servidor al sincronizar.
      </p>
      <div className="observation-location__actions">
        <button type="button" className="ghost-action"
          disabled={disabled || loading}
          onClick={requestLocation} aria-busy={loading}>
          {location ? <RotateCcw size={15} aria-hidden="true" /> : <LocateFixed size={15} aria-hidden="true" />}
          {loading ? 'Buscando señal GPS…' :
            location ? 'Actualizar ubicación' : 'Usar ubicación actual'}
        </button>
        {location && <button type="button" className="ghost-action"
          disabled={disabled || loading}
          onClick={() => { onChange(null); setError(''); }}>
          <X size={15} aria-hidden="true" /> Quitar ubicación
        </button>}
      </div>
      {loading && <p className="observation-location__status" role="status">
        Esperando precisión GPS del dispositivo (máximo 15 segundos)…
      </p>}
      {location && !loading && <div className="observation-location__fix" role="status">
        <LocateFixed size={17} aria-hidden="true" />
        <div>
          <strong>Ubicación lista para adjuntar</strong>
          <span>
            {location.point.coordinates[1].toFixed(5)}°, {location.point.coordinates[0].toFixed(5)}°
            {' · '}precisión reportada ±{location.accuracyMeters} m
          </span>
          <small>Se adjuntará solo al guardar esta observación. La precisión no garantiza un límite de lote.</small>
        </div>
      </div>}
      {error && <p className="observation-location__error" role="alert">
        <MapPinOff size={16} aria-hidden="true" /> {error}
      </p>}
      {!location && !loading && !error && <p className="observation-location__status">
        Sin GPS adjunto. Podés guardar la observación normalmente.
      </p>}
    </section>
  );
}
