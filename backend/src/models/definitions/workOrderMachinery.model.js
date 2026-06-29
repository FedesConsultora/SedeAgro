import { uuidPk } from './_shared.js';

export function defineWorkOrderMachinery(sequelize, DataTypes) {
  return sequelize.define('WorkOrderMachinery', {
    id: uuidPk(DataTypes),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    work_order_id: { type: DataTypes.UUID, allowNull: false },
    machinery_id: { type: DataTypes.UUID, allowNull: false },
    role: { type: DataTypes.STRING(80), allowNull: false, defaultValue: 'primary' }
  }, { tableName: 'work_order_machinery' });
}
