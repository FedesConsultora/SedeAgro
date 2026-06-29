import { uuidPk } from './_shared.js';

export function defineSyncBatch(sequelize, DataTypes) {
  return sequelize.define('SyncBatch', {
    id: uuidPk(DataTypes),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    submitted_by: DataTypes.UUID,
    client_id: { type: DataTypes.STRING(120), allowNull: false },
    device_id: DataTypes.STRING(120),
    status: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'received' },
    received_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    processed_at: DataTypes.DATE,
    conflict_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }
  }, { tableName: 'sync_batches', timestamps: false });
}
