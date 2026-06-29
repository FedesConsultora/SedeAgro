export function definePermission(sequelize, DataTypes) {
  return sequelize.define('Permission', {
    code: { type: DataTypes.STRING(120), primaryKey: true },
    description: DataTypes.TEXT
  }, { tableName: 'permissions', timestamps: false });
}
