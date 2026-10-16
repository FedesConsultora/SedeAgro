import { uuidPk } from './_shared.js';

export function defineWorkOrderExecutionException(sequelize, DataTypes) {
  return sequelize.define('WorkOrderExecutionException', {
    id: uuidPk(DataTypes),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    work_order_id: { type: DataTypes.UUID, allowNull: false },
    work_order_execution_id: { type: DataTypes.UUID, allowNull: false },
    input_id: { type: DataTypes.UUID, allowNull: false },
    client_request_id: { type: DataTypes.UUID, allowNull: false },
    submitted_by: { type: DataTypes.UUID, allowNull: false },
    quantity: { type: DataTypes.DECIMAL(12, 4), allowNull: false },
    input_name: { type: DataTypes.STRING(180), allowNull: false },
    unit: { type: DataTypes.STRING(40), allowNull: false },
    reason: { type: DataTypes.STRING(500), allowNull: false },
    review_status: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'submitted' },
    reviewed_by: DataTypes.UUID,
    reviewed_at: DataTypes.DATE,
    review_note: DataTypes.STRING(500)
  }, { tableName: 'work_order_execution_exceptions' });
}
