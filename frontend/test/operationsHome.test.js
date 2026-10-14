import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accessibleHomeKeys, decodeHomeCollection, emptyHomeResources, homeSnapshot
} from '../src/services/operationsHome.js';
import { canNavigateView } from '../src/services/navigationAccess.js';
import { countWorkOrderFilters, filterWorkOrders } from '../src/services/workOrderFilters.js';

const today = new Date('2026-10-14T12:00:00.000Z');
const ready = data => ({ state: 'ready', data });

test('home respects tenant role AND entitlements rather than paid modules alone', () => {
  const modules = ['gis', 'scouting', 'work_orders', 'campaigns'];
  assert.deepEqual(accessibleHomeKeys(modules, 'scout'), ['fields', 'campaigns', 'scoutingRuns']);
  assert.deepEqual(accessibleHomeKeys(modules, 'contractor'), ['orders']);
  assert.deepEqual(accessibleHomeKeys(modules, 'producer_viewer'), ['fields']);
  assert.deepEqual(accessibleHomeKeys(modules, 'unknown_role'), []);
  assert.equal(canNavigateView('dashboard', { role: 'contractor', entitlements: modules }), true);
  assert.equal(canNavigateView('orders', { role: 'scout', entitlements: modules }), false);
  assert.equal(canNavigateView('scouting', { role: 'contractor', entitlements: modules }), false);
  assert.equal(canNavigateView('fields', { role: 'producer_viewer', entitlements: modules }), true);
  assert.equal(canNavigateView('teams', { role: 'producer_viewer', entitlements: ['org'] }), false);
  assert.equal(canNavigateView('platform', { role: 'tenant_admin', platformAdmin: false }), false);
  assert.equal(canNavigateView('platform', { role: 'tenant_admin', platformAdmin: true }), true);
  assert.equal(canNavigateView('sessions', { role: 'scout' }), true);
  assert.equal(canNavigateView('nonexistent', { role: 'tenant_admin' }), false);
});

test('dashboard never fabricates field health or zero metrics after API failures', () => {
  const resources = emptyHomeResources();
  resources.fields = { state: 'error', data: [], error: 'falló el servidor' };
  resources.orders = ready([{ id: 'o1', status: 'in_progress', priority: 'urgent',
    due_at: '2026-10-15T00:00:00.000Z', title: 'Aplicar lote norte',
    Field: { name: 'Lote Norte' } }]);
  const summary = homeSnapshot(resources, today);
  assert.equal(summary.metrics.find(x => x.key === 'fields').value, null);
  assert.equal(summary.metrics.find(x => x.key === 'orders').value, 1);
  assert.deepEqual(summary.failedKeys, ['fields']);
  assert.equal(summary.alertCount, 1);
  assert.equal(summary.alerts[0].context, 'Lote Norte');
  assert.equal(summary.alerts[0].reason, 'Urgente');
  assert.equal(summary.alerts.every(item => item.view && item.id), true);
  assert.equal('healthScore' in summary, false);
});

test('priority ordering favors overdue work then urgent before pending approval, without completed records', () => {
  const resources = emptyHomeResources();
  resources.orders = ready([
    { id: 'b', title: 'Urgent', status: 'assigned', priority: 'urgent' },
    { id: 'c', title: 'Done', status: 'completed', priority: 'urgent',
      due_at: '2026-10-01T00:00:00.000Z' },
    { id: 'd', title: 'Approval', status: 'pending_approval', priority: 'normal' },
    { id: 'a', title: 'Late', status: 'assigned', priority: 'normal',
      due_at: '2026-10-12T00:00:00.000Z' },
    { id: 'z', title: 'Normal', status: 'assigned', priority: 'normal' }
  ]);
  resources.scoutingRuns = ready([
    { id: 'run1', status: 'planned', summary: 'Recorrida tarde',
      scheduled_at: '2026-10-13T08:00:00.000Z', CampaignField: { Field: { name: 'Lote 1' } } },
    { id: 'run2', status: 'completed', summary: 'Terminada',
      scheduled_at: '2026-10-01T08:00:00.000Z' }
  ]);
  const result = homeSnapshot(resources, today);
  assert.deepEqual(result.alerts.map(a => a.id), ['a', 'run1', 'b', 'd']);
  assert.equal(result.alertCount, 4);
  assert.equal(result.metrics.find(x => x.key === 'orders').value, 4);
  assert.equal(result.metrics.find(x => x.key === 'scoutingRuns').value, 1);
});

test('invalid payloads must be displayed as API errors, not interpreted as empty real lists', () => {
  assert.deepEqual(decodeHomeCollection({ data: [] }), []);
  assert.throws(() => decodeHomeCollection({ items: [] }), /formato/i);
  assert.throws(() => decodeHomeCollection(null), /formato/i);
});

test('order attention filter and search do not include archived or unrelated work', () => {
  const orders = [
    { id: '1', title: 'Revisar parcela', status: 'assigned', priority: 'high',
      Field: { name: 'La Esperanza' } },
    { id: '2', title: 'Cosechar', status: 'completed', priority: 'urgent' },
    { id: '3', title: 'Validar preparación', status: 'pending_approval', priority: 'normal' },
    { id: '4', title: 'Aplicar fertilizante', status: 'in_progress', priority: 'normal' }
  ];
  assert.deepEqual(filterWorkOrders(orders, { filter: 'attention' }).map(o => o.id), ['1', '3']);
  assert.deepEqual(filterWorkOrders(orders, { search: 'esperanza' }).map(o => o.id), ['1']);
  assert.deepEqual(filterWorkOrders(orders, { filter: 'attention', search: 'fertilizante' }), []);
  assert.deepEqual(countWorkOrderFilters(orders), {
    all: 4, attention: 2, assigned: 1, in_progress: 1, pending_approval: 1, completed: 1
  });
});
