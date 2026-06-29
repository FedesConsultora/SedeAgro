import { uuidPk } from './_shared.js';

export function defineWorkOrder(sequelize, DataTypes) {
  return sequelize.define('WorkOrder', {
    id: uuidPk(DataTypes),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    campaign_field_id: DataTypes.UUID,
    field_id: { type: DataTypes.UUID, allowNull: false },
    requested_by: DataTypes.UUID,
    type: { type: DataTypes.STRING(40), allowNull: false },
    status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'draft' },
    priority: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'normal' },
    due_at: DataTypes.DATE,
    title: { type: DataTypes.STRING(180), allowNull: false },
    instructions: DataTypes.TEXT,
    approved_at: DataTypes.DATE,
    completed_at: DataTypes.DATE
  }, { tableName: 'work_orders' });
}
