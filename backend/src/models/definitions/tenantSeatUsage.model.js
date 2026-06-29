import { uuidPk } from './_shared.js';

export function defineTenantSeatUsage(sequelize, DataTypes) {
  return sequelize.define('TenantSeatUsage', {
    id: uuidPk(DataTypes),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    snapshot_at: { type: DataTypes.DATE, allowNull: false },
    active_count: { type: DataTypes.INTEGER, allowNull: false },
    limit_count: { type: DataTypes.INTEGER, allowNull: false }
  }, { tableName: 'tenant_seat_usage', updatedAt: false });
}
