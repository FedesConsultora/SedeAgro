import { uuidPk } from './_shared.js';

export function defineTeam(sequelize, DataTypes) {
  return sequelize.define('Team', {
    id: uuidPk(DataTypes),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    name: { type: DataTypes.STRING(160), allowNull: false },
    scope: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'field_ops' },
    farm_id: DataTypes.UUID,
    notes: DataTypes.TEXT
  }, { tableName: 'teams' });
}
