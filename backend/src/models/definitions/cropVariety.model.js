import { uuidPk } from './_shared.js';

export function defineCropVariety(sequelize, DataTypes) {
  return sequelize.define('CropVariety', {
    id: uuidPk(DataTypes),
    crop_type_id: { type: DataTypes.UUID, allowNull: false },
    name: { type: DataTypes.STRING(140), allowNull: false }
  }, { tableName: 'crop_varieties', timestamps: false });
}
