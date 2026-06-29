export function defineModule(sequelize, DataTypes) {
  return sequelize.define('Module', {
    code: { type: DataTypes.STRING(80), primaryKey: true },
    name: { type: DataTypes.STRING(140), allowNull: false },
    description: DataTypes.TEXT,
    is_starter: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }
  }, { tableName: 'modules', timestamps: false });
}
