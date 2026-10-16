import { uuidPk } from './_shared.js';

export function defineWorkOrderExecution(sequelize, DataTypes) {
  return sequelize.define('WorkOrderExecution', {
    id: uuidPk(DataTypes),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    work_order_id: { type: DataTypes.UUID, allowNull: false },
    submitted_by: { type: DataTypes.UUID, allowNull: false },
    started_at: { type: DataTypes.DATE, allowNull: false },
    finished_at: { type: DataTypes.DATE, allowNull: false },
    worked_area_hectares: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    result_summary: { type: DataTypes.STRING(2000), allowNull: false },
    review_status: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'submitted' },
    reviewed_by: DataTypes.UUID,
    reviewed_at: DataTypes.DATE,
    review_note: DataTypes.STRING(500),
    review_checklist: DataTypes.JSONB,
    input_declaration: DataTypes.JSONB
  }, { tableName: 'work_order_executions' });
}
