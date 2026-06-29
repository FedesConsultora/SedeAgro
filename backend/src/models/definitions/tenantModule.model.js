export function defineTenantModule(sequelize, DataTypes) {
  return sequelize.define('TenantModule', {
    tenant_id: { type: DataTypes.UUID, primaryKey: true },
    module_code: { type: DataTypes.STRING(80), primaryKey: true },
    is_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    source: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'plan' }
  }, { tableName: 'tenant_modules' });
}
