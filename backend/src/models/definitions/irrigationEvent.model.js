import { uuidPk } from './_shared.js';

export function defineIrrigationEvent(sequelize, DataTypes) {
  return sequelize.define('IrrigationEvent', {
    id: uuidPk(DataTypes),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    field_id: { type: DataTypes.UUID, allowNull: false },
    recorded_by: DataTypes.UUID,
    amount_mm: DataTypes.DECIMAL(8, 2),
    started_at: { type: DataTypes.DATE, allowNull: false },
    ended_at: DataTypes.DATE,
    source: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'manual' },
    notes: DataTypes.TEXT
  }, { tableName: 'irrigation_events' });
}
