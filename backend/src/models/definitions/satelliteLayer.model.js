import { uuidPk } from './_shared.js';

export function defineSatelliteLayer(sequelize, DataTypes) {
  return sequelize.define('SatelliteLayer', {
    id: uuidPk(DataTypes),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    field_id: { type: DataTypes.UUID, allowNull: false },
    provider: { type: DataTypes.STRING(80), allowNull: false },
    layer_type: { type: DataTypes.STRING(40), allowNull: false },
    captured_at: { type: DataTypes.DATE, allowNull: false },
    storage_key: { type: DataTypes.TEXT, allowNull: false },
    metadata: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} }
  }, { tableName: 'satellite_layers' });
}
