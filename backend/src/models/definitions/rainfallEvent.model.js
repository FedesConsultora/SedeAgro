import { uuidPk } from './_shared.js';

export function defineRainfallEvent(sequelize, DataTypes) {
  return sequelize.define('RainfallEvent', {
    id: uuidPk(DataTypes),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    field_id: { type: DataTypes.UUID, allowNull: false },
    recorded_by: DataTypes.UUID,
    amount_mm: { type: DataTypes.DECIMAL(8, 2), allowNull: false },
    measured_at: { type: DataTypes.DATE, allowNull: false },
    source: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'manual' },
    notes: DataTypes.TEXT
  }, { tableName: 'rainfall_events' });
}
