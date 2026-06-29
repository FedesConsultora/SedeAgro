import { uuidPk } from './_shared.js';

export function definePlatformAuditLog(sequelize, DataTypes) {
  return sequelize.define('PlatformAuditLog', {
    id: uuidPk(DataTypes),
    actor_id: DataTypes.UUID,
    tenant_id: DataTypes.UUID,
    action: { type: DataTypes.STRING(120), allowNull: false },
    payload: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} }
  }, { tableName: 'platform_audit_logs', updatedAt: false });
}
