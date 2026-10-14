import { Notification } from '../../models/index.js';
import { assignmentNotice } from './assignmentNotificationPolicy.js';

// Call AFTER the assignment has been written, using the same request transaction.
// A failure to create this record must roll back the assignment as well.
export async function createAssignmentNotification(req, { entityType, entityId, userId }) {
  if (!req?.dbTransaction || !req?.tenantId) {
    throw new Error('Una notificación de asignación requiere transacción de empresa.');
  }
  return Notification.create(assignmentNotice({
    tenantId: req.tenantId,
    userId,
    entityType,
    entityId
  }), { transaction: req.dbTransaction });
}
