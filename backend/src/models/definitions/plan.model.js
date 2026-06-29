import { uuidPk } from './_shared.js';

export function definePlan(sequelize, DataTypes) {
  return sequelize.define('Plan', {
    id: uuidPk(DataTypes),
    code: { type: DataTypes.STRING(80), allowNull: false, unique: true },
    name: { type: DataTypes.STRING(140), allowNull: false },
    max_users: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 5 },
    limits: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }
  }, { tableName: 'plans' });
}
