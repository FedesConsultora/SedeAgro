import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const router = readFileSync(
  new URL('../src/modules/notifications/router.js', import.meta.url), 'utf8'
);

test('GET /notifications explicitly selects active tenant and current user', () => {
  assert.match(router,
    /notificationsRouter\.get\('\/'[\s\S]*?where: \{ tenant_id: req\.tenantId, user_id: req\.auth\.user\.id \}/);
});

test('PATCH /notifications/:id/read is still scoped to tenant, user and notification ID', () => {
  assert.match(router,
    /notificationsRouter\.patch\('\/:id\/read'[\s\S]*?where: \{ id: req\.params\.id, tenant_id: req\.tenantId, user_id: req\.auth\.user\.id \}/);
  assert.match(router, /if \(!notification\) return res\.status\(404\)/);
  assert.match(router, /await notification\.update\(\{ read_at: new Date\(\) \}, \{ transaction: req\.dbTransaction \}\)/);
});
