import { useEffect, useRef, useState } from 'react';
import { useSession } from '../context/SessionContext.jsx';
import { sessionScope } from '../services/offlineSyncModel.js';
import { createMobileCaptureFence } from '../services/mobileCaptureSafety.js';
import { createPrivateUploadCache } from '../services/privateEvidenceUpload.js';
import {
  canUploadExecutionEvidence,
  validateExecutionEvidenceResponse, decodePrivateEvidenceResponse
} from '../services/executionEvidence.js';

const statusLabels = { verified: 'Archivo íntegro', mismatch: 'Integridad fallida',
  missing: 'Archivo no disponible', unverifiable: 'No verificable', oversize: 'Archivo excedido' };

export function WorkOrderExecutionEvidence({ order, reports, onChanged }) {
  const { api, dataMode, session } = useSession();
  const live = dataMode === 'live' && session?.authenticated === true;
  const userId = session?.user?.id;
  const identity = sessionScope(session);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [uploadFor, setUploadFor] = useState(null);
  const [file, setFile] = useState(null);
  const [uploadKey, setUploadKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [checks, setChecks] = useState({});
  const [opened, setOpened] = useState(null);
  const urlRef = useRef(null);
  const uploadCache = useRef(null);
  const uploadInFlight = useRef(null);
  const uploadFence = useRef(null);
  const viewFence = useRef(null);
  if (!uploadCache.current) uploadCache.current = createPrivateUploadCache();
  if (!uploadFence.current) uploadFence.current = createMobileCaptureFence();
  if (!viewFence.current) viewFence.current = createMobileCaptureFence();
  const uploadScope = live && identity && uploadFor && uploadKey
    ? `${identity}:${order.id}:${uploadFor}:${uploadKey}` : null;
  uploadFence.current.setScope(uploadScope);
  const viewScope = live && identity ? `${identity}:${order.id}` : null;
  viewFence.current.setScope(viewScope);
  useEffect(() => {
    uploadFence.current.setScope(uploadScope);
    return () => uploadFence.current.invalidate();
  }, [uploadScope]);
  useEffect(() => {
    viewFence.current.setScope(viewScope);
    return () => viewFence.current.invalidate();
  }, [viewScope]);
  useEffect(() => {
    // A different user in the same tenant is also a different security scope.
    uploadCache.current.reset();
    setUploadFor(null);
    setFile(null);
    setUploadKey('');
    setBusy(false);
    setOpened(null);
    setChecks({});
    setItems([]);
  }, [order.id, identity, live]);

  useEffect(() => {
    if (!live) return undefined;
    let active = true;
    setItems([]);
    setLoading(true);
    setError('');
    api.request(`/work-orders/${encodeURIComponent(order.id)}/execution-evidence`, { silent: true })
      .then(response => {
        if (!Array.isArray(response?.data) ||
            !response.data.every(asset => asset && typeof asset.id === 'string' &&
              reports.some(report => report.id === asset.work_order_execution_id))) {
          throw new Error('El servidor devolvió adjuntos inválidos para esta orden.');
        }
        if (active) setItems(response.data);
      })
      .catch(err => { if (active) setError(err?.message || 'No se pudieron cargar los adjuntos.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, live, order.id, identity, revision, reports]);

  useEffect(() => () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
  }, [order.id, identity, live]);

  if (!live || reports.length === 0) return null;

  const updateFile = chosen => {
    uploadCache.current.reset();
    setFile(chosen);
    // A retry preserves this UUID; selecting another file generates a new one.
    setUploadKey(chosen ? crypto.randomUUID() : '');
    setError('');
  };

  const upload = async event => {
    event.preventDefault();
    const report = reports.find(item => item.id === uploadFor);
    if (!report || !canUploadExecutionEvidence(report, order.status, userId, live) || busy) return;
    const ticket = uploadFence.current.ticket();
    // Keep HTTP single-flight even if two submit events arrive before React
    // commits busy=true. A ticket from a previous tenant/order is not current.
    if (!uploadFence.current.isCurrent(ticket) ||
        uploadFence.current.isCurrent(uploadInFlight.current)) return;
    uploadInFlight.current = ticket;
    setBusy(true);
    setError('');
    try {
      // Cache the *prepared* JPEG payload before HTTP. If an ACK is lost,
      // retrying this UUID must use byte-identical content.
      const payload = await uploadCache.current.prepare(file, uploadKey);
      if (!uploadFence.current.isCurrent(ticket)) return;
      const response = await api.request(
        `/work-orders/${encodeURIComponent(order.id)}/executions/${encodeURIComponent(report.id)}/evidence`, {
          method: 'POST', silent: true,
          body: { ...payload, client_upload_id: uploadKey }
        });
      if (!uploadFence.current.isCurrent(ticket)) return;
      validateExecutionEvidenceResponse(response, report.id);
      uploadCache.current.reset();
      setBusy(false);
      setUploadFor(null);
      setFile(null);
      setUploadKey('');
      setRevision(n => n + 1);
      onChanged?.();
    } catch (err) {
      // Network ambiguity leaves both UUID and encoded bytes unchanged.
      if (uploadFence.current.isCurrent(ticket)) {
        setError(err?.message || 'No se confirmó la carga. Podés reintentar.');
      }
    } finally {
      // Late settlement for a stale user/order must not release a new ticket.
      if (uploadInFlight.current === ticket) uploadInFlight.current = null;
      if (uploadFence.current.isCurrent(ticket)) setBusy(false);
    }
  };

  const check = async asset => {
    if (busy) return;
    const ticket = viewFence.current.ticket();
    if (!viewFence.current.isCurrent(ticket)) return;
    setBusy(true);
    setError('');
    try {
      const response = await api.request(
        `/work-orders/${encodeURIComponent(order.id)}/evidence/${encodeURIComponent(asset.id)}/integrity`,
        { silent: true });
      if (!viewFence.current.isCurrent(ticket)) return;
      if (response?.data?.id !== asset.id || !Object.hasOwn(statusLabels, response.data.status)) {
        throw new Error('La comprobación no fue confirmada por el servidor.');
      }
      setChecks(current => ({ ...current, [asset.id]: response.data.status }));
    } catch (err) {
      if (viewFence.current.isCurrent(ticket)) {
        setError(err?.message || 'No se pudo comprobar el archivo.');
      }
    } finally {
      if (viewFence.current.isCurrent(ticket)) setBusy(false);
    }
  };

  const open = async asset => {
    if (busy) return;
    const ticket = viewFence.current.ticket();
    if (!viewFence.current.isCurrent(ticket)) return;
    setBusy(true);
    setError('');
    try {
      const response = await api.request(
        `/work-orders/${encodeURIComponent(order.id)}/evidence/${encodeURIComponent(asset.id)}/content`,
        { silent: true });
      if (!viewFence.current.isCurrent(ticket)) return;
      const blob = decodePrivateEvidenceResponse(response, asset.id, asset.mime_type);
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      setOpened({ id: asset.id, url, name: asset.original_name,
        mime: asset.mime_type });
    } catch (err) {
      if (viewFence.current.isCurrent(ticket)) {
        setOpened(null);
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
        setError(err?.message || 'No se pudo abrir el archivo privado.');
      }
    } finally {
      if (viewFence.current.isCurrent(ticket)) setBusy(false);
    }
  };

  return <section className="detail-section order-detail__evidence">
    <h3>Archivos de respaldo</h3>
    <p>Fotos o PDF aportados por quien presentó el parte. Un adjunto no certifica por sí solo
      el trabajo ni reemplaza la revisión independiente.</p>
    {loading && <p role="status">Consultando archivos privados…</p>}
    {error && <div className="order-detail__error" role="alert">
      {error} <button type="button" className="ghost-action"
        onClick={() => setRevision(n => n + 1)}>Reintentar consulta</button>
    </div>}
    {reports.map(report => {
      const files = items.filter(asset => asset.work_order_execution_id === report.id);
      const allowed = canUploadExecutionEvidence(report, order.status, userId, live);
      return <div key={report.id} className="order-detail__execution-record">
        <strong>Respaldo del parte {report.id.slice(0, 8)}… ({files.length}/8)</strong>
        {files.length === 0 && !loading && <p>Sin archivos adjuntos.</p>}
        {files.map(asset => <div key={asset.id} className="order-detail__attachment">
          <span>{asset.original_name} · {(asset.size_bytes / 1024).toFixed(0)} KiB</span>
          <div className="order-detail__execution-actions">
            <button type="button" className="ghost-action" disabled={busy}
              onClick={() => void check(asset)}>Comprobar integridad</button>
            <button type="button" className="ghost-action" disabled={busy}
              onClick={() => void open(asset)}>Abrir privado</button>
          </div>
          {checks[asset.id] && <span role="status">{statusLabels[checks[asset.id]]}</span>}
        </div>)}
        {allowed && files.length < 8 && <button type="button" className="ghost-action"
          disabled={busy} onClick={() => {
            uploadCache.current.reset();
            setUploadFor(report.id);
            setFile(null);
            setUploadKey('');
            setError('');
          }}>Adjuntar foto o PDF</button>}
        {uploadFor === report.id && allowed && <form className="order-detail__execution-form" onSubmit={upload}>
          <label className="form-field">Archivo real (foto JPEG/PNG/WebP/HEIC/HEIF original hasta 12 MiB (si el navegador la decodifica), convertida a JPEG privado de 512 KiB; PDF hasta 2 MiB sin cambios)
            <input type="file" required accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf"
              disabled={busy} onChange={event => updateFile(event.target.files?.[0] || null)} />
          </label>
          <div className="order-detail__execution-actions">
            <button type="submit" className="primary-action" disabled={busy || !file || !uploadKey}>
              {busy ? 'Adjuntando…' : 'Guardar respaldo privado'}
            </button>
            <button type="button" className="ghost-action" disabled={busy} onClick={() => {
              uploadCache.current.reset();
              setUploadFor(null); setFile(null); setUploadKey('');
            }}>Cancelar</button>
          </div>
        </form>}
      </div>;
    })}
    {opened && <div className="order-detail__execution-record" aria-label="Archivo privado abierto">
      <p>Archivo descargado con sesión activa: <strong>{opened.name}</strong></p>
      {opened.mime !== 'application/pdf' && <img src={opened.url} alt="Respaldo privado declarado"
        style={{ maxWidth: '100%', maxHeight: 360, objectFit: 'contain' }} />}
      <a href={opened.url} download={opened.name} className="ghost-action">Descargar archivo</a>
      <button type="button" className="ghost-action" onClick={() => {
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = null; setOpened(null);
      }}>Cerrar archivo</button>
    </div>}
  </section>;
}
