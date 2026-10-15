import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const businessRouters = [
  'farms', 'fields', 'campaigns', 'scouting', 'workOrders',
  'teams', 'assets', 'imagery', 'reports', 'sync'
];

function file(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

test('all business route declarations have an explicit capability guard', () => {
  let count = 0;
  for (const name of businessRouters) {
    const source = file(`../src/modules/${name}/router.js`);
    const routeLines = source.split('\n').filter((line) =>
      /^\w+Router\.(get|post|patch|delete|put)\('/.test(line));
    assert.ok(routeLines.length > 0, `no recognized endpoints for ${name}`);
    for (const route of routeLines) {
      assert.match(route, /requireCapability\('[a-z_.]+'\)/, `missing capability on ${name}: ${route}`);
      count += 1;
    }
  }
  assert.equal(count, 65, 'update the reviewed endpoint count when changing the API');
});

test('tenant member listing is guarded, and personal notifications require ownership', () => {
  assert.match(file('../src/modules/auth/router.js'),
    /authScopedRouter\.get\('\/members', requireCapability\('members\.read'\)/);
  const notifications = file('../src/modules/notifications/router.js');
  assert.match(notifications, /user_id: req\.auth\.user\.id/);
  assert.match(notifications, /where: \{ id: req\.params\.id, tenant_id: req\.tenantId, user_id: req\.auth\.user\.id \}/);
});

test('contractor order lookup is scoped to assignment and order creation is draft-only', () => {
  const orders = file('../src/modules/workOrders/router.js');
  assert.match(orders, /\[Op\.in\]: assignments\.map/);
  assert.match(orders, /contractorAssignedToOrder\(req, req\.params\.id\)/);
  assert.match(orders, /status: z\.literal\('draft'\)\.optional\(\)/);
});
