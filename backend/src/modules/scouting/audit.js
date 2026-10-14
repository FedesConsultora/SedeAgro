import { AuditEvent } from '../../models/index.js';

// Keep audit data deliberately small and non-sensitive. Never copy request bodies,
// offline payloads, evidence bytes, free-text notes or access tokens into this log.
export async function recordScoutingAudit(req, { runId, action, before = null, after = null }) {
  return AuditEvent.create({
    tenant_id: req.tenantId,
    actor_id: req.auth.user.id,
    action,
    entity_type: 'scouting_run',
    entity_id: runId,
    before,
    after,
    request_id: req.requestId
  }, { transaction: req.dbTransaction });
}
