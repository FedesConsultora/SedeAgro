import { uuidPk } from './_shared.js';

export function defineFarm(sequelize, DataTypes) {
  return sequelize.define('Farm', {
    id: uuidPk(DataTypes),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    producer_id: DataTypes.UUID,
    name: { type: DataTypes.STRING(180), allowNull: false },
    locality: DataTypes.STRING(140),
    province: DataTypes.STRING(140),
    country: { type: DataTypes.STRING(80), allowNull: false, defaultValue: 'Argentina' },
    centroid: DataTypes.GEOMETRY('POINT', 4326),
    notes: DataTypes.TEXT
  }, { tableName: 'farms' });
}
