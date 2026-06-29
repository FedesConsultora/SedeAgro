import { uuidPk } from './_shared.js';

export function defineScoutingRun(sequelize, DataTypes) {
  return sequelize.define('ScoutingRun', {
    id: uuidPk(DataTypes),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    campaign_field_id: { type: DataTypes.UUID, allowNull: false },
    assigned_to: DataTypes.UUID,
    scheduled_at: DataTypes.DATE,
    completed_at: DataTypes.DATE,
    status: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'planned' },
    summary: DataTypes.TEXT
  }, { tableName: 'scouting_runs' });
}
