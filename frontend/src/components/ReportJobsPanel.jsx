import { useEffect, useRef, useState } from 'react';
import { useSession } from '../context/SessionContext.jsx';
import { sessionScope } from '../services/offlineSyncModel.js';
import { decodeAsyncReportFile } from '../services/reportArtifactClient.js';

// Async reporting is explicitly separate from the immediate CSV/PDF/XLSX buttons.
export function ReportJobsPanel({ fields }) {
  const { api, dataMode, session } = useSession();
  const scope = dataMode === 'live' ? sessionScope(session) : null;
  const current = useRef(null);
  current.current = { scope, api };
  const [templates, setTemplates] = useState([]);
  const [runs, setRuns] = useState([]);
  const [workerOnline, setWorkerOnline] = useState(false);
  const [templateId, setTemplateId] = useState('');
  const [fieldId, setFieldId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const lock = useRef(false);
  const isCurrent = (origin) =>
    Boolean(origin.scope && current.current?.scope === origin.scope &&
      current.current.api === origin.api);

  const refresh = async (origin, quiet = false) => {
    if (!isCurrent(origin)) return;
    try {
      const [t, r, w] = await Promise.all([
        origin.api.reportTemplates(), origin.api.reportRuns(), origin.api.reportWorkerStatus()
      ]);
      if (!isCurrent(origin)) return;
      setTemplates((t.data || []).filter(item => item.scope === 'field' &&
        item.is_active && ['csv', 'pdf', 'xlsx'].includes(item.format)));
      setRuns((r.data || []).slice(0, 30));
      setWorkerOnline(Boolean(w.data?.online));
      if (!quiet) setError('');
    } catch (err) {
      if (isCurrent(origin) && !quiet) setError(err?.message || 'No se pudieron cargar los reportes.');
    }
  };

  useEffect(() => {
    if (!scope) return undefined;
    const origin = { scope, api };
    setTemplates([]);
    setRuns([]);
    setTemplateId('');
    setWorkerOnline(false);
    setError('');
    void refresh(origin);
    const ticker = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh(origin, true);
    }, 8000);
    return () => clearInterval(ticker);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, api]);

  const perform = async (action) => {
    const origin = { scope, api };
    if (!isCurrent(origin) || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      await action(origin);
      if (isCurrent(origin)) await refresh(origin, true);
    } catch (err) {
      if (isCurrent(origin)) setError(err?.message || 'No se pudo completar la operación.');
    } finally {
      lock.current = false;
      if (isCurrent(origin)) setBusy(false);
    }
  };

  const createTemplate = format => perform(async origin => {
    const result = await origin.api.createReportTemplate({
      name: `Reporte por lote ${format.toUpperCase()}`,
      code: `field-${format}`, scope: 'field', format,
      config: {}, is_active: true
    });
    if (isCurrent(origin)) {
      setTemplateId(result.data.id);
      setStatus(`Plantilla ${format.toUpperCase()} creada.`);
    }
  });

  const queue = () => perform(async origin => {
    if (!workerOnline) throw new Error('No hay un worker activo para esta empresa.');
    if (!templateId || !fieldId || !fields.some(f => f.id === fieldId)) {
      throw new Error('Seleccioná una plantilla y un lote autorizado.');
    }
    if (from && to && from > to) throw new Error('El fin del período precede al inicio.');
    const response = await origin.api.createReportRun({
      report_template_id: templateId,
      filters: { field_id: fieldId },
      ...(from ? { period_start: from } : {}),
      ...(to ? { period_end: to } : {})
    });
    if (isCurrent(origin)) setStatus(`Reporte solicitado: ${response.data.id}. Consultá el estado abajo.`);
  });

  const cancel = runId => perform(async origin => {
    await origin.api.cancelReportRun(runId);
    if (isCurrent(origin)) setStatus('Reporte cancelado.');
  });

  const download = runId => perform(async origin => {
    const response = await origin.api.downloadReportRun(runId);
    if (!isCurrent(origin)) return;
    const { blob, filename } = await decodeAsyncReportFile(response.data);
    if (!isCurrent(origin)) return;
    const url = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
    if (isCurrent(origin)) setStatus('Archivo verificado por SHA-256 y descargado.');
  });

  if (dataMode !== 'live' || !scope) return null;

  return (
    <section aria-label="Reportes programados por lote" className="panel"
      style={{ padding: 16, display: 'grid', gap: 12 }}>
      <h2 style={{ margin: 0 }}>Procesamiento de reportes</h2>
      <p style={{ margin: 0, fontSize: 13 }}>Los reportes se procesan por empresa y quedan disponibles hasta 7 días.
        Los archivos se descargan únicamente cuando el procesamiento termina.</p>
      <p role="status" style={{ margin: 0 }}>
        Procesador de esta empresa: <strong>{workerOnline ? 'Disponible' : 'No disponible'}</strong>
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button type="button" className="ghost-action" disabled={busy}
          onClick={() => void refresh({ scope, api })}>Actualizar estado</button>
        {['csv', 'pdf', 'xlsx'].filter(f => !templates.some(t => t.code === `field-${f}`))
          .map(format => (
            <button type="button" key={format} className="ghost-action" disabled={busy}
              onClick={() => void createTemplate(format)}>Crear plantilla {format.toUpperCase()}</button>
          ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'end', gap: 10 }}>
        <label style={{ display: 'grid', gap: 4 }}>Plantilla
          <select value={templateId} disabled={busy} onChange={e => setTemplateId(e.target.value)}>
            <option value="">Seleccionar formato</option>
            {templates.map(t => <option key={t.id} value={t.id}>{t.name} · {t.format.toUpperCase()}</option>)}
          </select>
        </label>
        <label style={{ display: 'grid', gap: 4 }}>Lote
          <select value={fieldId} disabled={busy} onChange={e => setFieldId(e.target.value)}>
            <option value="">Seleccionar lote</option>
            {fields.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </label>
        <label style={{ display: 'grid', gap: 4 }}>Desde (UTC)
          <input type="date" value={from} max={to || undefined}
            onChange={e => setFrom(e.target.value)} disabled={busy}/>
        </label>
        <label style={{ display: 'grid', gap: 4 }}>Hasta (UTC)
          <input type="date" value={to} min={from || undefined}
            onChange={e => setTo(e.target.value)} disabled={busy}/>
        </label>
        <button type="button" className="primary-action"
          disabled={busy || !workerOnline || !templateId || !fieldId}
          onClick={() => void queue()}>Solicitar reporte</button>
      </div>
      {error && <p role="alert" style={{ margin: 0 }}>{error}</p>}
      {status && <p role="status" style={{ margin: 0 }}>{status}</p>}
      <h3 style={{ margin: 0 }}>Últimos reportes</h3>
      {!runs.length ? <p style={{ margin: 0 }}>Todavía no hay trabajos registrados.</p> : (
        <ul style={{ display: 'grid', gap: 8, paddingLeft: 16, margin: 0 }}>
          {runs.map(r => <li key={r.id}>
            <span>{r.ReportTemplate?.name || 'Reporte'} — <strong>{r.status}</strong></span>
            {r.error_code && <span> · Error: {r.error_code}</span>}
            {r.status === 'completed' &&
              <button type="button" className="ghost-action" disabled={busy}
                onClick={() => void download(r.id)}>Descargar</button>}
            {['queued', 'running'].includes(r.status) &&
              <button type="button" className="ghost-action" disabled={busy}
                onClick={() => void cancel(r.id)}>Cancelar</button>}
          </li>)}
        </ul>
      )}
    </section>
  );
}
