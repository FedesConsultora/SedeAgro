import { uuidPk } from './_shared.js';

export function defineTenantIntegration(sequelize, DataTypes) {
  return sequelize.define('TenantIntegration', {
    id: uuidPk(DataTypes),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    provider: { type: DataTypes.STRING(80), allowNull: false },
    credentials: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    expires_at: DataTypes.DATE
  }, { tableName: 'tenant_integrations' });
}
