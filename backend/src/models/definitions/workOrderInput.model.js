import { uuidPk } from './_shared.js';

export function defineWorkOrderInput(sequelize, DataTypes) {
  return sequelize.define('WorkOrderInput', {
    id: uuidPk(DataTypes),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    work_order_id: { type: DataTypes.UUID, allowNull: false },
    input_id: { type: DataTypes.UUID, allowNull: false },
    dose: DataTypes.DECIMAL(12, 4),
    dose_unit: DataTypes.STRING(40),
    total_quantity: DataTypes.DECIMAL(12, 4),
    notes: DataTypes.TEXT
  }, { tableName: 'work_order_inputs' });
}
