import { uuidPk } from './_shared.js';

export function defineReportRun(sequelize, DataTypes) {
  return sequelize.define('ReportRun', {
    id: uuidPk(DataTypes),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    report_template_id: { type: DataTypes.UUID, allowNull: false },
    requested_by: DataTypes.UUID,
    status: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'queued' },
    period_start: DataTypes.DATEONLY,
    period_end: DataTypes.DATEONLY,
    filters: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    storage_key: DataTypes.TEXT,
    generated_at: DataTypes.DATE,
    attempt_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    lease_token: DataTypes.UUID,
    lease_expires_at: DataTypes.DATE,
    next_attempt_at: DataTypes.DATE,
    error_code: DataTypes.STRING(64)
  }, { tableName: 'report_runs' });
}
