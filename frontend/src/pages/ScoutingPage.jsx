import { useCallback, useEffect, useState } from 'react';
import { Activity, ChevronRight, Download, Plus, RefreshCw } from 'lucide-react';
import { useSession } from '../context/SessionContext.jsx';
import { mockData } from '../services/mockData.js';
import { ScoutingRunFormModal } from '../components/ScoutingRunFormModal.jsx';
import { ObservationFormModal } from '../components/ObservationFormModal.jsx';
import { EvidenceUploadModal } from '../components/EvidenceUploadModal.jsx';
import { EvidencePreviewModal } from '../components/EvidencePreviewModal.jsx';
import { ScoutingAuditPanel } from '../components/ScoutingAuditPanel.jsx';

const RUN_STATUS_ES = { planned: 'Planificado', in_progress: 'En curso', completed: 'Completado', cancelled: 'Cancelado' };
const SEV_ES = { low: 'Leve', medium: 'Moderado', high: 'Alto', critical: 'Crítico' };
const OBS_TYPE_ES = { weed: 'Maleza', pest: 'Plaga', disease: 'Enfermedad', phenology: 'Fenología', nutrition: 'Nutrición', water: 'Agua', general: 'General' };
const STATUS_FILTER = ['Todos', 'planned', 'in_progress', 'completed', 'cancelled'];

function StatusBadge({ status }) {
  return <span className={`status-badge status-badge--${status}`}>{RUN_STATUS_ES[status] || status}</span>;
}

function RunDetail({ run, onChanged }) {
  const { api, dataMode, session } = useSession();
  const [details, setDetails] = useState(dataMode === 'mock' ? run : null);
  const [loading, setLoading] = useState(dataMode === 'live');
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [working, setWorking] = useState(false);
  const [showObsModal, setShowObsModal] = useState(false);
  const [queuedNotice, setQueuedNotice] = useState('');
  const [showEvidModal, setShowEvidModal] = useState(null);
  const [downloadingId, setDownloadingId] = useState(null);
  const [preview, setPreview] = useState(null);
  const [showAudit, setShowAudit] = useState(false);
  const [eligibleAssignees, setEligibleAssignees] = useState([]);
  const [selectedAssignee, setSelectedAssignee] = useState('');
  const [loadingAssignees, setLoadingAssignees] = useState(false);

  const refresh = useCallback(async () => {
    if (dataMode !== 'live') {
      setDetails(run);
      setError('');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const response = await api.getScoutingRun(run.id);
      setDetails(response.data);
      setSelectedAssignee(response.data.assigned_to || '');
    } catch (err) {
      setDetails(null);
      setError(err?.message || 'No se pudo cargar la recorrida.');
    } finally {
      setLoading(false);
    }
  }, [api, dataMode, run]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (dataMode !== 'live' || !['tenant_admin', 'agronomic_coordinator'].includes(session?.membership?.roleCode)) return;
    let cancelled = false;
    setLoadingAssignees(true);
    api.scoutingAssignees()
      .then((result) => { if (!cancelled) setEligibleAssignees(result.data || []); })
      .catch((err) => { if (!cancelled) setActionError(err?.message || 'No se pudieron cargar responsables.'); })
      .finally(() => { if (!cancelled) setLoadingAssignees(false); });
    return () => { cancelled = true; };
  }, [api, dataMode, session?.membership?.roleCode]);

  const role = session?.membership?.roleCode;
  const canManage = dataMode === 'live' && ['tenant_admin', 'agronomic_coordinator'].includes(role);
  const canOperate = dataMode === 'live' && (
    canManage || (role === 'scout' && details?.assigned_to === session?.user?.id)
  );
  const canObserve = canOperate && ['planned', 'in_progress'].includes(details?.status);

  const assign = async () => {
    setWorking(true);
    setActionError('');
    try {
      await api.updateScoutingRun(run.id, { assigned_to: selectedAssignee || null });
      await refresh();
      onChanged?.();
    } catch (err) {
      setActionError(err?.message || 'No se pudo actualizar el responsable.');
    } finally {
      setWorking(false);
    }
  };

  const changeStatus = async (status) => {
    setWorking(true);
    setActionError('');
    try {
      if (role === 'scout') await api.advanceScoutingRun(run.id, status);
      else await api.updateScoutingRun(run.id, { status });
      await refresh();
      onChanged?.();
    } catch (err) {
      setActionError(err?.message || 'No se pudo actualizar el estado.');
    } finally {
      setWorking(false);
    }
  };

  const download = async (evidence) => {
    setDownloadingId(evidence.id);
    setActionError('');
    try {
      const result = await api.getEvidenceContent(evidence.id);
      const encoded = result.data.content_base64;
      const binary = atob(encoded);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: result.data.mime_type });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = result.data.original_name || 'evidencia';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setActionError(err?.message || 'No se pudo descargar el archivo.');
    } finally {
      setDownloadingId(null);
    }
  };

  const observations = details?.ScoutingObservations || [];

  return (
    <div style={{ padding: '16px 24px', borderTop: '1px solid rgba(0,0,0,0.06)', display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <strong style={{ fontSize: 13, color: '#334155' }}>Observaciones ({observations.length})</strong>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {canOperate && details?.status === 'planned' &&
            <button type="button" className="ghost-action" disabled={working || !details?.assigned_to}
              title={!details?.assigned_to ? 'Primero asigná un responsable' : undefined}
              onClick={() => changeStatus('in_progress')}>Iniciar recorrida</button>}
          {canOperate && details?.status === 'in_progress' &&
            <button type="button" className="ghost-action" disabled={working} onClick={() => changeStatus('completed')}>Completar recorrida</button>}
          {canManage && ['planned', 'in_progress'].includes(details?.status) &&
            <button type="button" className="ghost-action" disabled={working}
              onClick={() => { if (window.confirm('¿Cancelar esta recorrida? No se podrá reabrir.')) void changeStatus('cancelled'); }}>
              Cancelar recorrida
            </button>}
          {canManage && <button type="button" className="ghost-action"
            aria-expanded={showAudit} onClick={() => setShowAudit((value) => !value)}>
            {showAudit ? 'Ocultar historial' : 'Ver historial'}
          </button>}
          <button type="button" className="ghost-action" onClick={() => refresh()} disabled={loading}>
            <RefreshCw size={14} /> Actualizar
          </button>
          {canObserve && <button type="button" className="ghost-action" onClick={() => setShowObsModal(true)}>
            <Plus size={14} /> Agregar observación
          </button>}
        </div>
      </div>
      {!loading && !error && focusRunId && !runs.some(run => run.id === focusRunId) &&
        <p className="auth-error" role="status">
          La recorrida solicitada no está disponible para esta cuenta.
        </p>}
      {error && <div className="auth-error" role="alert">{error} <button type="button" onClick={() => refresh()}>Reintentar</button></div>}
      {actionError && <div className="auth-error" role="alert">{actionError}</div>}
      {queuedNotice && <div role="status" style={{ padding: '10px 12px',
        background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 8,
        fontSize: 12, color: '#065f46' }}>
        {queuedNotice}
      </div>}
      {canManage && details?.status === 'planned' && (
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
          <label className="form-field" style={{ minWidth: 220 }}>
            <span>Responsable de la recorrida</span>
            <select value={selectedAssignee} onChange={(event) => setSelectedAssignee(event.target.value)}
              disabled={working || loadingAssignees}>
              <option value="">Sin asignar</option>
              {eligibleAssignees.map((person) => <option key={person.id} value={person.id}>
                {person.name} · {person.role_code === 'scout' ? 'Monitoreador' : 'Coordinador'}
              </option>)}
            </select>
          </label>
          <button type="button" className="ghost-action" disabled={working || loadingAssignees || selectedAssignee === (details.assigned_to || '')}
            onClick={() => void assign()}>Guardar responsable</button>
          {!details.assigned_to && <span style={{ color: '#a16207', fontSize: 12 }}>
            Es obligatorio asignar antes de iniciar.
          </span>}
        </div>
      )}
      {loading ? <p style={{ color: '#64748b', fontSize: 13 }}>Cargando datos de la recorrida…</p>
        : !details ? null
          : observations.length === 0 ? (
            <p style={{ color: '#64748b', fontSize: 13, margin: 0 }}>No hay observaciones guardadas en esta recorrida.</p>
          ) : (
            <div style={{ display: 'grid', gap: 12 }}>
              {observations.map((obs) => (
                <div key={obs.id} style={{ padding: '12px 14px', borderRadius: 10, border: '1px solid rgba(15,23,42,0.09)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span className={`status-badge status-badge--${obs.severity === 'critical' ? 'rose' : obs.severity === 'high' ? 'amber' : 'green'}`}>
                      {SEV_ES[obs.severity] || obs.severity}
                    </span>
                    <strong style={{ color: '#334155', fontSize: 13 }}>{OBS_TYPE_ES[obs.observation_type] || obs.observation_type}</strong>
                    <span style={{ color: '#64748b', fontSize: 12 }}>{obs.observed_at ? new Date(obs.observed_at).toLocaleString('es-AR') : ''}</span>
                  </div>
                  <p style={{ margin: '8px 0', fontSize: 13, color: '#475569', whiteSpace: 'pre-wrap' }}>{obs.notes}</p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {(obs.EvidenceAssets || []).map((ev) => (
                      <div key={ev.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                        <span style={{ flex: 1, color: '#64748b' }}>{ev.original_name || 'Archivo'} · {ev.size_bytes ? `${Math.ceil(ev.size_bytes / 1024)} KiB` : 'Archivo legado'}</span>
                        {dataMode === 'live' && ev.mime_type?.startsWith('image/') && <button className="ghost-action" type="button"
                          onClick={() => setPreview(ev)}>Ver foto</button>}
                        {dataMode === 'live' && <button className="ghost-action" type="button" disabled={downloadingId === ev.id} onClick={() => download(ev)}>
                          <Download size={13} /> {downloadingId === ev.id ? 'Descargando…' : 'Descargar'}
                        </button>}
                      </div>
                    ))}
                  </div>
                  {canObserve && <button className="ghost-action" type="button"
                    style={{ marginTop: 8 }} onClick={() => setShowEvidModal(obs.id)}>+ Adjuntar archivo</button>}
                </div>
              ))}
            </div>
          )}
      {showAudit && canManage && <ScoutingAuditPanel runId={run.id} />}
      {dataMode !== 'live' && <p style={{ fontSize: 12, color: '#a16207', margin: 0 }}>Modo demo: estos datos no provienen del backend; no se guardan modificaciones.</p>}
      {showObsModal && <ObservationFormModal isOpen runId={run.id} onClose={() => setShowObsModal(false)}
        onQueued={() => {
          setShowObsModal(false);
          setQueuedNotice('Observación guardada en este dispositivo. Se enviará automáticamente al recuperar conexión; podés ver el estado en Sincronizaciones.');
        }}
        onCreated={() => { setShowObsModal(false); void refresh(); onChanged?.(); }} />}
      {showEvidModal && <EvidenceUploadModal isOpen observationId={showEvidModal} onClose={() => setShowEvidModal(null)}
        onCreated={() => { setShowEvidModal(null); void refresh(); }} />}
      {preview && <EvidencePreviewModal isOpen evidence={preview} api={api} onClose={() => setPreview(null)} />}
    </div>
  );
}

export function ScoutingPage({ focusRunId = null }) {
  const { api, dataMode, session } = useSession();
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('Todos');
  const [expanded, setExpanded] = useState({});
  const [showModal, setShowModal] = useState(false);
  const canPlan = dataMode === 'live' && ['tenant_admin', 'agronomic_coordinator'].includes(session?.membership?.roleCode);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    if (dataMode === 'mock') {
      setRuns(mockData.scoutingRuns);
      setLoading(false);
      return;
    }
    try {
      const response = await api.scoutingRuns();
      setRuns(response.data || []);
    } catch (err) {
      setRuns([]);
      setError(err?.message || 'No se pudo consultar el servidor de monitoreos.');
    } finally {
      setLoading(false);
    }
  }, [api, dataMode]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!focusRunId) return;
    setFilter('Todos');
    setExpanded(current => ({ ...current, [focusRunId]: true }));
  }, [focusRunId]);
  const visible = filter === 'Todos' ? runs : runs.filter((r) => r.status === filter);

  return (
    <div className="page-grid">
      <section className="page-heading">
        <div><span className="eyebrow">Control de cultivos</span><h1>Monitoreo</h1></div>
        {canPlan && <button type="button" className="primary-action" onClick={() => setShowModal(true)}>
          <Plus size={16} /> Nueva recorrida
        </button>}
      </section>
      <div className="page-toolbar">
        <div className="filter-bar">
          {STATUS_FILTER.map((s) => (
            <button key={s} type="button" className={`filter-chip ${filter === s ? 'filter-chip--active' : ''}`}
              onClick={() => setFilter(s)}>{s === 'Todos' ? 'Todos' : RUN_STATUS_ES[s] || s}</button>
          ))}
        </div>
        <span style={{ fontSize: 13, color: '#64748b' }}>
          {visible.length} recorridas · {dataMode === 'live' ? 'Backend' : 'Demo'}
        </span>
      </div>
      {error && <div className="auth-error" role="alert">
        {error} <button type="button" onClick={() => load()}>Reintentar</button>
      </div>}
      <div className="data-table-wrapper">
        <div className="data-table">
          <div className="data-table__row data-table__row--head" style={{ gridTemplateColumns: '2fr 1fr 1fr 1fr 40px' }}>
            <span>Lote / Campaña</span><span>Fecha planificada</span><span>Estado</span><span>Asignado a</span><span />
          </div>
          {loading ? <div style={{ padding: 24, fontSize: 13, color: '#64748b' }}>Cargando recorridas…</div>
            : error ? null : visible.length === 0 ? (
              <div className="empty-state">
                <Activity size={36} />
                <h3>Sin recorridas</h3>
                <p>{dataMode === 'live' ? 'Todavía no hay recorridas registradas.' : 'Vista de demostración.'}</p>
              </div>
            ) : visible.map((run) => (
              <div key={run.id}>
                <button type="button" className="data-table__row" aria-expanded={Boolean(expanded[run.id])}
                  style={{ gridTemplateColumns: '2fr 1fr 1fr 1fr 40px', cursor: 'pointer', width: '100%', textAlign: 'left', border: 0, background: 'transparent' }}
                  onClick={() => setExpanded((current) => ({ ...current, [run.id]: !current[run.id] }))}>
                  <span><strong>{run.CampaignField?.Field?.name || 'Lote'}</strong></span>
                  <span>{run.scheduled_at ? new Date(run.scheduled_at).toLocaleDateString('es-AR') : '–'}</span>
                  <span><StatusBadge status={run.status} /></span>
                  <span>{run.assignee?.full_name || (run.assigned_to ? 'Responsable asignado' : 'Sin asignar')}</span>
                  <ChevronRight size={16} style={{ color: '#94a3b8', transform: expanded[run.id] ? 'rotate(90deg)' : 'none' }} />
                </button>
                {expanded[run.id] && <RunDetail run={run} onChanged={load} />}
              </div>
            ))}
        </div>
      </div>
      {showModal && <ScoutingRunFormModal isOpen onClose={() => setShowModal(false)}
        onCreated={() => { setShowModal(false); void load(); }} />}
    </div>
  );
}
