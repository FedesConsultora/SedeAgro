import { uuidPk } from './_shared.js';

export function defineScoutingObservation(sequelize, DataTypes) {
  return sequelize.define('ScoutingObservation', {
    id: uuidPk(DataTypes),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    scouting_run_id: { type: DataTypes.UUID, allowNull: false },
    field_id: { type: DataTypes.UUID, allowNull: false },
    observed_by: DataTypes.UUID,
    observation_type: { type: DataTypes.STRING(40), allowNull: false },
    severity: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'low' },
    point: DataTypes.GEOMETRY('POINT', 4326),
    notes: DataTypes.TEXT,
    observed_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW }
  }, { tableName: 'scouting_observations' });
}
