export function definePlanModule(sequelize, DataTypes) {
  return sequelize.define('PlanModule', {
    plan_id: { type: DataTypes.UUID, primaryKey: true },
    module_code: { type: DataTypes.STRING(80), primaryKey: true }
  }, { tableName: 'plan_modules', timestamps: false });
}
