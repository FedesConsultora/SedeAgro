import { uuidPk } from './_shared.js';

export function defineMachinery(sequelize, DataTypes) {
  return sequelize.define('Machinery', {
    id: uuidPk(DataTypes),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    name: { type: DataTypes.STRING(180), allowNull: false },
    kind: { type: DataTypes.STRING(60), allowNull: false },
    brand: DataTypes.STRING(120),
    model: DataTypes.STRING(120),
    serial_number: DataTypes.STRING(120),
    status: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'active' },
    metadata: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} }
  }, { tableName: 'machinery' });
}
