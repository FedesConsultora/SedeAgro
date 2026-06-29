import { uuidPk } from './_shared.js';

export function defineReportTemplate(sequelize, DataTypes) {
  return sequelize.define('ReportTemplate', {
    id: uuidPk(DataTypes),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    name: { type: DataTypes.STRING(180), allowNull: false },
    code: { type: DataTypes.STRING(80), allowNull: false },
    scope: { type: DataTypes.STRING(40), allowNull: false },
    format: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'pdf' },
    config: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }
  }, { tableName: 'report_templates' });
}
