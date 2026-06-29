import { uuidPk } from './_shared.js';

export function defineTenant(sequelize, DataTypes) {
  return sequelize.define('Tenant', {
    id: uuidPk(DataTypes),
    plan_id: { type: DataTypes.UUID, allowNull: false },
    name: { type: DataTypes.STRING(180), allowNull: false },
    slug: { type: DataTypes.STRING(90), allowNull: false, unique: true },
    status: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'onboarding' },
    default_locale: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'es-AR' },
    timezone: { type: DataTypes.STRING(80), allowNull: false, defaultValue: 'America/Argentina/Buenos_Aires' },
    billing_email: DataTypes.STRING(320),
    deleted_at: DataTypes.DATE
  }, { tableName: 'tenants', paranoid: true, deletedAt: 'deleted_at' });
}
