import { uuidPk } from './_shared.js';

export function defineAgriculturalInput(sequelize, DataTypes) {
  return sequelize.define('AgriculturalInput', {
    id: uuidPk(DataTypes),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    name: { type: DataTypes.STRING(180), allowNull: false },
    category: { type: DataTypes.STRING(60), allowNull: false },
    unit: { type: DataTypes.STRING(40), allowNull: false },
    active_ingredient: DataTypes.STRING(180),
    registration_number: DataTypes.STRING(120),
    metadata: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} }
  }, { tableName: 'agricultural_inputs' });
}
