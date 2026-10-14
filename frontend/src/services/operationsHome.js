// Actionable homepage projections. Never derive a "healthy field" estimate
// from unrelated work orders; only count records the API actually returned.
const ACCESS = {
  fields: { entitlement: 'gis', roles: ['tenant_admin', 'agronomic_coordinator', 'scout', 'producer_viewer'] },
  campaigns: { entitlement: 'campaigns', roles: ['tenant_admin', 'agronomic_coordinator', 'scout'] },
  scoutingRuns: { entitlement: 'scouting', roles: ['tenant_admin', 'agronomic_coordinator', 'scout'] },
  orders: { entitlement: 'work_orders', roles: ['tenant_admin', 'agronomic_coordinator', 'contractor'] }
};

export const HOME_KEYS = Object.freeze(Object.keys(ACCESS));

export function accessibleHomeKeys(entitlements = [], role = '') {
  return HOME_KEYS.filter(key =>
    entitlements.includes(ACCESS[key].entitlement) && ACCESS[key].roles.includes(role));
}

export function decodeHomeCollection(response) {
  if (Array.isArray(response?.data)) return response.data;
  throw new Error('El servidor respondió con un formato de datos inesperado.');
}

export function emptyHomeResources() {
  return Object.fromEntries(HOME_KEYS.map(key => [key, { state: 'unavailable', data: [] }]));
}

export function homeSnapshot(resources, now = new Date()) {
  const ready = key => resources?.[key]?.state === 'ready';
  const records = key => ready(key) && Array.isArray(resources[key].data) ? resources[key].data : [];
  const fields = records('fields');
  const orders = records('orders');
  const campaigns = records('campaigns');
  const runs = records('scoutingRuns');
  const isActive = order => !['completed', 'cancelled'].includes(order.status);
  const open = orders.filter(isActive);
  const alerts = [];

  for (const order of open) {
    const due = order.due_at ? new Date(order.due_at).getTime() : null;
    const overdue = due !== null && Number.isFinite(due) && due < now.getTime();
    const urgent = order.priority === 'urgent';
    const high = order.priority === 'high';
    if (!urgent && !high && !overdue && order.status !== 'pending_approval') continue;
    alerts.push({
      id: order.id, kind: 'order', view: 'orders',
      title: order.title || 'Orden sin título',
      context: order.Field?.name || 'Lote no especificado',
      date: Number.isFinite(due) ? due : null,
      reason: overdue ? 'Vencida' : urgent ? 'Urgente' : high ? 'Alta prioridad' : 'Pendiente de aprobación',
      weight: overdue ? 0 : urgent ? 1 : high ? 2 : 3
    });
  }
  for (const run of runs) {
    if (!['planned', 'in_progress'].includes(run.status)) continue;
    const due = run.scheduled_at ? new Date(run.scheduled_at).getTime() : null;
    const overdue = due !== null && Number.isFinite(due) && due < now.getTime();
    if (!overdue && run.status !== 'in_progress') continue;
    alerts.push({
      id: run.id, kind: 'scouting', view: 'scouting',
      title: run.summary || 'Recorrida de monitoreo',
      context: run.CampaignField?.Field?.name || 'Lote no especificado',
      date: Number.isFinite(due) ? due : null,
      reason: overdue && run.status === 'planned' ? 'Recorrida atrasada' : 'En curso',
      weight: overdue && run.status === 'planned' ? 1 : 4
    });
  }
  alerts.sort((a, b) =>
    a.weight - b.weight ||
    (a.date ?? Number.MAX_SAFE_INTEGER) - (b.date ?? Number.MAX_SAFE_INTEGER) ||
    a.title.localeCompare(b.title, 'es') || a.id.localeCompare(b.id));

  return {
    metrics: [
      { key: 'fields', label: 'Hectáreas registradas',
        value: ready('fields') ? fields.reduce((sum, item) => sum +
          (Number.isFinite(Number(item.area_hectares)) ? Math.max(0, Number(item.area_hectares)) : 0), 0)
          .toLocaleString('es-AR', { maximumFractionDigits: 1 }) : null, unit: 'ha' },
      { key: 'campaigns', label: 'Campañas activas',
        value: ready('campaigns') ? campaigns.filter(item => item.status === 'active').length : null },
      { key: 'scoutingRuns', label: 'Recorridas pendientes',
        value: ready('scoutingRuns') ? runs.filter(item => ['planned', 'in_progress'].includes(item.status)).length : null },
      { key: 'orders', label: 'Órdenes abiertas',
        value: ready('orders') ? open.length : null }
    ],
    alerts: alerts.slice(0, 7),
    alertCount: alerts.length,
    readyCount: HOME_KEYS.filter(ready).length,
    failedKeys: HOME_KEYS.filter(key => resources?.[key]?.state === 'error')
  };
}
