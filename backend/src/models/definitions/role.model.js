export function defineRole(sequelize, DataTypes) {
  return sequelize.define('Role', {
    code: { type: DataTypes.STRING(80), primaryKey: true },
    name: { type: DataTypes.STRING(140), allowNull: false },
    scope: { type: DataTypes.STRING(24), allowNull: false },
    description: DataTypes.TEXT
  }, { tableName: 'roles', timestamps: false });
}
