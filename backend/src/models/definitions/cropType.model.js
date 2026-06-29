import { uuidPk } from './_shared.js';

export function defineCropType(sequelize, DataTypes) {
  return sequelize.define('CropType', {
    id: uuidPk(DataTypes),
    code: { type: DataTypes.STRING(80), allowNull: false, unique: true },
    name: { type: DataTypes.STRING(140), allowNull: false }
  }, { tableName: 'crop_types', timestamps: false });
}
