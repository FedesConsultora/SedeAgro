import { uuidPk } from './_shared.js';

export function defineCampaignField(sequelize, DataTypes) {
  return sequelize.define('CampaignField', {
    id: uuidPk(DataTypes),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    campaign_id: { type: DataTypes.UUID, allowNull: false },
    field_id: { type: DataTypes.UUID, allowNull: false },
    crop_type_id: { type: DataTypes.UUID, allowNull: false },
    crop_variety_id: DataTypes.UUID,
    planting_date: DataTypes.DATEONLY,
    harvest_target_date: DataTypes.DATEONLY,
    expected_yield: DataTypes.DECIMAL(12, 2),
    status: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'planned' }
  }, { tableName: 'campaign_fields' });
}
