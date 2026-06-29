import { uuidPk } from './_shared.js';

export function defineUser(sequelize, DataTypes) {
  return sequelize.define('User', {
    id: uuidPk(DataTypes),
    email: { type: DataTypes.STRING(320), allowNull: false, unique: true },
    password_hash: { type: DataTypes.TEXT, allowNull: false },
    full_name: { type: DataTypes.STRING(180), allowNull: false },
    phone: DataTypes.STRING(80),
    status: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'active' },
    is_platform_admin: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }
  }, { tableName: 'users' });
}
