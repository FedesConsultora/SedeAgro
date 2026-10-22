import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reportAccessContext, confirmFieldReportResponse, visibleFieldReport
} from '../src/services/reportAccessContext.js';

const session = Object.freeze({
  authenticated: true,
  tenant: { id: 'tenant-1' },
  user: { id: 'user-1', isPlatformAdmin: false },
  membership: { roleCode: 'agronomic_coordinator' },
  entitlements: ['reports', 'scouting', 'work_orders']
});

test('field report access identity changes on tenant, actor, role, privileges or field', () => {
  const original = reportAccessContext(session, 'live', 'field-1');
  assert.ok(original);
  assert.equal(reportAccessContext({
    ...session, entitlements: ['work_orders', 'reports', 'scouting', 'reports']
  }, 'live', 'field-1'), original, 'order/duplicate grants must not remount a valid report');
  for (const altered of [
    { ...session, tenant: { id: 'tenant-2' } },
    { ...session, user: { ...session.user, id: 'user-2' } },
    { ...session, membership: { roleCode: 'scout' } },
    { ...session, entitlements: ['scouting'] },
    { ...session, user: { ...session.user, isPlatformAdmin: true } }
  ]) assert.notEqual(reportAccessContext(altered, 'live', 'field-1'), original);
  assert.notEqual(reportAccessContext(session, 'live', 'field-2'), original);
});

test('demo and unauthenticated cold start never become a report access context', () => {
  assert.equal(reportAccessContext(session, 'mock'), null);
  assert.equal(reportAccessContext({ ...session, authenticated: false }, 'live'), null);
  assert.equal(reportAccessContext({ ...session, user: {} }, 'live'), null);
  assert.equal(reportAccessContext({ ...session, tenant: {} }, 'live'), null);
  assert.equal(reportAccessContext(null, 'live'), null);
});

test('render-time masking hides the old summary BEFORE effects clear state', () => {
  const api = { getFieldReport: () => null };
  const scope = reportAccessContext(session, 'live', 'field-1');
  const snapshot = { scope, api, report: { privateOrders: ['A'] } };
  assert.equal(visibleFieldReport(snapshot, scope, api), snapshot.report);
  assert.equal(visibleFieldReport(snapshot, reportAccessContext({
    ...session, membership: { roleCode: 'scout' }
  }, 'live', 'field-1'), api), null);
  assert.equal(visibleFieldReport(snapshot, scope, {}), null);
  assert.equal(visibleFieldReport(snapshot, null, api), null);
  assert.equal(visibleFieldReport(null, scope, api), null);
});

test('field summary only accepts the selected ID, not another field in the same tenant', () => {
  const payload = { data: { field: { id: 'field-1' }, workOrdersSummary: { open: 3 } } };
  assert.equal(confirmFieldReportResponse(payload, 'field-1'), payload.data);
  for (const invalid of [
    null, {}, { data: null }, { data: {} }, { data: { field: { id: 'field-2' } } }
  ]) assert.throws(() => confirmFieldReportResponse(invalid, 'field-1'), /lote seleccionado/i);
  assert.throws(() => confirmFieldReportResponse(payload, 'field-2'), /lote seleccionado/i);
});

const source = path => readFileSync(new URL(path, import.meta.url), 'utf8');
test('reports page scopes card and async job panel by current live permissions', () => {
  const page = source('../src/pages/ReportsPage.jsx');
  const jobs = source('../src/components/ReportJobsPanel.jsx');
  assert.match(page, /reportAccessContext\(session, dataMode\)/);
  assert.match(page, /key=\{reportPrincipal/);
  assert.match(jobs, /reportAccessContext\(session, dataMode\)/);
  assert.match(jobs, /current\.current\?\.scope === origin\.scope/);
});

test('field summary never commits an old HTTP response or exports outside original authority', () => {
  const card = source('../src/components/FieldReportCard.jsx');
  assert.match(card, /confirmFieldReportResponse\(res, fieldId\)/);
  assert.match(card, /loadSequence\.current === sequence/);
  assert.match(card, /currentScope\.current === scope/);
  assert.match(card, /reportAccessContext\(session, dataMode, fieldId\)/);
  assert.match(card, /visibleFieldReport\(reportState, reportContext, api\)/);
  assert.match(card, /URL\.revokeObjectURL/);
});
