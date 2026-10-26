import { uuidPk } from './_shared.js';

export function defineMemberInvitation(sequelize, DataTypes) {
  return sequelize.define('MemberInvitation', {
    id: uuidPk(DataTypes),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    email: { type: DataTypes.STRING(320), allowNull: false },
    role_code: { type: DataTypes.STRING(80), allowNull: false },
    token_hash: { type: DataTypes.STRING(64), allowNull: false },
    status: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'pending' },
    expires_at: { type: DataTypes.DATE, allowNull: false },
    invited_by: { type: DataTypes.UUID, allowNull: false },
    accepted_by: DataTypes.UUID,
    accepted_at: DataTypes.DATE,
    revoked_at: DataTypes.DATE
  }, { tableName: 'member_invitations' });
}
