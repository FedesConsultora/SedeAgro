import { uuidPk } from './_shared.js';

export function defineWorkOrderAssignee(sequelize, DataTypes) {
  return sequelize.define('WorkOrderAssignee', {
    id: uuidPk(DataTypes),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    work_order_id: { type: DataTypes.UUID, allowNull: false },
    user_id: { type: DataTypes.UUID, allowNull: false },
    responsibility: { type: DataTypes.STRING(80), allowNull: false, defaultValue: 'executor' },
    status: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'assigned' }
  }, { tableName: 'work_order_assignees' });
}
