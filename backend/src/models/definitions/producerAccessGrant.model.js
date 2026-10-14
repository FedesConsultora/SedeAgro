import { uuidPk } from './_shared.js';

export function defineProducerAccessGrant(sequelize, DataTypes) {
  return sequelize.define('ProducerAccessGrant', {
    id: uuidPk(DataTypes),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    user_id: { type: DataTypes.UUID, allowNull: false },
    producer_id: { type: DataTypes.UUID, allowNull: false },
    granted_by: DataTypes.UUID
  }, { tableName: 'producer_access_grants' });
}
