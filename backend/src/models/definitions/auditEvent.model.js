import { uuidPk } from './_shared.js';

export function defineAuditEvent(sequelize, DataTypes) {
  return sequelize.define('AuditEvent', {
    id: uuidPk(DataTypes),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    actor_id: DataTypes.UUID,
    action: { type: DataTypes.STRING(120), allowNull: false },
    entity_type: { type: DataTypes.STRING(80), allowNull: false },
    entity_id: DataTypes.UUID,
    before: DataTypes.JSONB,
    after: DataTypes.JSONB,
    request_id: DataTypes.UUID
  }, { tableName: 'audit_events', updatedAt: false });
}
