import { uuidPk } from './_shared.js';

export function defineCampaign(sequelize, DataTypes) {
  return sequelize.define('Campaign', {
    id: uuidPk(DataTypes),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    name: { type: DataTypes.STRING(160), allowNull: false },
    season_year: { type: DataTypes.INTEGER, allowNull: false },
    starts_at: { type: DataTypes.DATEONLY, allowNull: false },
    ends_at: DataTypes.DATEONLY,
    status: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'planned' }
  }, { tableName: 'campaigns' });
}
