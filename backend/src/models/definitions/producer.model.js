import { uuidPk } from './_shared.js';

export function defineProducer(sequelize, DataTypes) {
  return sequelize.define('Producer', {
    id: uuidPk(DataTypes),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    name: { type: DataTypes.STRING(180), allowNull: false },
    tax_id: DataTypes.STRING(64),
    contact_email: DataTypes.STRING(320),
    contact_phone: DataTypes.STRING(80),
    notes: DataTypes.TEXT
  }, { tableName: 'producers' });
}
