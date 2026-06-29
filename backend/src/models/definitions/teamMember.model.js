import { uuidPk } from './_shared.js';

export function defineTeamMember(sequelize, DataTypes) {
  return sequelize.define('TeamMember', {
    id: uuidPk(DataTypes),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    team_id: { type: DataTypes.UUID, allowNull: false },
    user_id: { type: DataTypes.UUID, allowNull: false },
    role_label: { type: DataTypes.STRING(80), allowNull: false, defaultValue: 'member' }
  }, { tableName: 'team_members' });
}
