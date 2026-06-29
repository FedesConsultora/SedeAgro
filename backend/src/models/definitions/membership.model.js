import { uuidPk } from './_shared.js';

export function defineMembership(sequelize, DataTypes) {
  return sequelize.define('Membership', {
    id: uuidPk(DataTypes),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    user_id: { type: DataTypes.UUID, allowNull: false },
    role_code: { type: DataTypes.STRING(80), allowNull: false },
    status: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'active' },
    is_bot: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    joined_at: DataTypes.DATE,
    invited_by: DataTypes.UUID
  }, { tableName: 'memberships' });
}
