import { uuidPk } from './_shared.js';

export function defineNotification(sequelize, DataTypes) {
  return sequelize.define('Notification', {
    id: uuidPk(DataTypes),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    user_id: { type: DataTypes.UUID, allowNull: false },
    type: { type: DataTypes.STRING(80), allowNull: false },
    title: { type: DataTypes.STRING(180), allowNull: false },
    body: DataTypes.TEXT,
    entity_type: DataTypes.STRING(80),
    entity_id: DataTypes.UUID,
    read_at: DataTypes.DATE
  }, { tableName: 'notifications' });
}
