import { uuidPk } from './_shared.js';

export function defineSyncOperation(sequelize, DataTypes) {
  return sequelize.define('SyncOperation', {
    id: uuidPk(DataTypes),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    sync_batch_id: { type: DataTypes.UUID, allowNull: false },
    entity_type: { type: DataTypes.STRING(80), allowNull: false },
    entity_client_id: DataTypes.STRING(120),
    operation: { type: DataTypes.STRING(24), allowNull: false },
    payload: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    status: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'pending' },
    error: DataTypes.TEXT
  }, { tableName: 'sync_operations', timestamps: false });
}
