import { uuidPk } from './_shared.js';

export function defineField(sequelize, DataTypes) {
  return sequelize.define('Field', {
    id: uuidPk(DataTypes),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    farm_id: { type: DataTypes.UUID, allowNull: false },
    name: { type: DataTypes.STRING(180), allowNull: false },
    area_hectares: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    boundary: DataTypes.GEOMETRY('POLYGON', 4326),
    status: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'active' },
    notes: DataTypes.TEXT
  }, { tableName: 'fields' });
}
