export function defineRolePermission(sequelize, DataTypes) {
  return sequelize.define('RolePermission', {
    role_code: { type: DataTypes.STRING(80), primaryKey: true },
    permission_code: { type: DataTypes.STRING(120), primaryKey: true }
  }, { tableName: 'role_permissions', timestamps: false });
}
