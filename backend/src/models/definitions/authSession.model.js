import { uuidPk } from './_shared.js';

export function defineAuthSession(sequelize, DataTypes) {
  return sequelize.define('AuthSession', {
    id: uuidPk(DataTypes),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    user_id: { type: DataTypes.UUID, allowNull: false },
    expires_at: { type: DataTypes.DATE, allowNull: false },
    revoked_at: DataTypes.DATE
  }, { tableName: 'auth_sessions' });
}
