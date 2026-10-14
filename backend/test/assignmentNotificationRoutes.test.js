import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL('../src/modules/' + path, import.meta.url), 'utf8');
const scouting = read('scouting/router.js');
const orders = read('workOrders/router.js');
const publisher = read('notifications/assignmentNotifications.js');

test('scouting creation and locked reassignment emit only when a real user is assigned', () => {
  assert.match(scouting, /ScoutingRun\.create\(req\.body, \{ transaction: req\.dbTransaction \}\);[\s\S]*?shouldNotifyRunAssignment\(null, run\.assigned_to\)/);
  assert.match(scouting, /const run = await findRun\(req, req\.params\.id, true\);/);
  assert.match(scouting, /await run\.update\(update, \{ transaction: req\.dbTransaction \}\);\s*if \(shouldNotifyRunAssignment\(previous\.assigned_to, run\.assigned_to\)\)/);
  assert.match(scouting, /await verifyAssignee\(req, req\.body\.assigned_to\)/);
});

test('work order locks parent and emits a single notice for newly created active assignee', () => {
  const assignment = orders.split("workOrdersRouter.post('/:id/assignees'")[1].split("workOrdersRouter.post('/:id/inputs'")[0];
  assert.match(assignment, /WorkOrder\.findByPk\(req\.params\.id, \{[\s\S]*?lock: req\.dbTransaction\.LOCK\.UPDATE/);
  assert.match(assignment, /model: User,[\s\S]*?where: \{ status: 'active' \}/);
  assert.match(assignment, /role_code: \{ \[Op\.in\]: ORDER_RECIPIENT_ROLES \}/);
  assert.match(assignment, /WorkOrderAssignee\.findOrCreate\(\{[\s\S]*?transaction: req\.dbTransaction/);
  assert.match(assignment, /if \(created\) \{\s*await createAssignmentNotification\(req/);
  assert.match(assignment, /res\.status\(created \? 201 : 200\)/);
});

test('event creation uses the request transaction and rejects unscoped calls', () => {
  assert.match(publisher, /if \(!req\?\.dbTransaction \|\| !req\?\.tenantId\)/);
  assert.match(publisher, /Notification\.create\(assignmentNotice\(\{/);
  assert.match(publisher, /transaction: req\.dbTransaction/);
  assert.doesNotMatch(publisher, /afterCommit|setTimeout|process\.nextTick/);
});
