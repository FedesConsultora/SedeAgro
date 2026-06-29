export function associateModels(models) {
  const {
    User,
    Plan,
    Module,
    PlanModule,
    Role,
    Permission,
    RolePermission,
    Tenant,
    Membership,
    TenantModule,
    Producer,
    Farm,
    Field,
    CropType,
    CropVariety,
    Campaign,
    CampaignField,
    ScoutingRun,
    ScoutingObservation,
    EvidenceAsset,
    WorkOrder,
    WorkOrderAssignee,
    RainfallEvent,
    IrrigationEvent,
    Team,
    TeamMember,
    Machinery,
    AgriculturalInput,
    WorkOrderInput,
    WorkOrderMachinery,
    SatelliteLayer,
    ReportTemplate,
    ReportRun,
    SyncBatch,
    SyncOperation,
    Notification
  } = models;

  Plan.hasMany(Tenant, { foreignKey: 'plan_id' });
  Tenant.belongsTo(Plan, { foreignKey: 'plan_id' });
  Plan.belongsToMany(Module, { through: PlanModule, foreignKey: 'plan_id', otherKey: 'module_code' });
  Module.belongsToMany(Plan, { through: PlanModule, foreignKey: 'module_code', otherKey: 'plan_id' });
  Role.belongsToMany(Permission, { through: RolePermission, foreignKey: 'role_code', otherKey: 'permission_code' });
  Permission.belongsToMany(Role, { through: RolePermission, foreignKey: 'permission_code', otherKey: 'role_code' });
  Tenant.belongsToMany(Module, { through: TenantModule, foreignKey: 'tenant_id', otherKey: 'module_code' });
  Module.belongsToMany(Tenant, { through: TenantModule, foreignKey: 'module_code', otherKey: 'tenant_id' });
  Tenant.hasMany(Membership, { foreignKey: 'tenant_id' });
  Membership.belongsTo(Tenant, { foreignKey: 'tenant_id' });
  User.hasMany(Membership, { foreignKey: 'user_id' });
  Membership.belongsTo(User, { foreignKey: 'user_id' });
  Role.hasMany(Membership, { foreignKey: 'role_code' });
  Membership.belongsTo(Role, { foreignKey: 'role_code' });

  Producer.hasMany(Farm, { foreignKey: 'producer_id' });
  Farm.belongsTo(Producer, { foreignKey: 'producer_id' });
  Farm.hasMany(Field, { foreignKey: 'farm_id' });
  Field.belongsTo(Farm, { foreignKey: 'farm_id' });
  Farm.hasMany(Team, { foreignKey: 'farm_id' });
  Team.belongsTo(Farm, { foreignKey: 'farm_id' });
  Team.hasMany(TeamMember, { foreignKey: 'team_id' });
  TeamMember.belongsTo(Team, { foreignKey: 'team_id' });
  User.hasMany(TeamMember, { foreignKey: 'user_id' });
  TeamMember.belongsTo(User, { foreignKey: 'user_id' });

  Campaign.hasMany(CampaignField, { foreignKey: 'campaign_id' });
  CampaignField.belongsTo(Campaign, { foreignKey: 'campaign_id' });
  Field.hasMany(CampaignField, { foreignKey: 'field_id' });
  CampaignField.belongsTo(Field, { foreignKey: 'field_id' });
  CropType.hasMany(CropVariety, { foreignKey: 'crop_type_id' });
  CropVariety.belongsTo(CropType, { foreignKey: 'crop_type_id' });
  CropType.hasMany(CampaignField, { foreignKey: 'crop_type_id' });
  CampaignField.belongsTo(CropType, { foreignKey: 'crop_type_id' });
  CropVariety.hasMany(CampaignField, { foreignKey: 'crop_variety_id' });
  CampaignField.belongsTo(CropVariety, { foreignKey: 'crop_variety_id' });

  CampaignField.hasMany(ScoutingRun, { foreignKey: 'campaign_field_id' });
  ScoutingRun.belongsTo(CampaignField, { foreignKey: 'campaign_field_id' });
  ScoutingRun.hasMany(ScoutingObservation, { foreignKey: 'scouting_run_id' });
  ScoutingObservation.belongsTo(ScoutingRun, { foreignKey: 'scouting_run_id' });
  Field.hasMany(ScoutingObservation, { foreignKey: 'field_id' });
  ScoutingObservation.belongsTo(Field, { foreignKey: 'field_id' });
  ScoutingObservation.hasMany(EvidenceAsset, { foreignKey: 'scouting_observation_id' });
  EvidenceAsset.belongsTo(ScoutingObservation, { foreignKey: 'scouting_observation_id' });

  Field.hasMany(WorkOrder, { foreignKey: 'field_id' });
  WorkOrder.belongsTo(Field, { foreignKey: 'field_id' });
  CampaignField.hasMany(WorkOrder, { foreignKey: 'campaign_field_id' });
  WorkOrder.belongsTo(CampaignField, { foreignKey: 'campaign_field_id' });
  WorkOrder.hasMany(WorkOrderAssignee, { foreignKey: 'work_order_id' });
  WorkOrderAssignee.belongsTo(WorkOrder, { foreignKey: 'work_order_id' });
  WorkOrder.hasMany(EvidenceAsset, { foreignKey: 'work_order_id' });
  EvidenceAsset.belongsTo(WorkOrder, { foreignKey: 'work_order_id' });
  WorkOrder.hasMany(WorkOrderInput, { foreignKey: 'work_order_id' });
  WorkOrderInput.belongsTo(WorkOrder, { foreignKey: 'work_order_id' });
  AgriculturalInput.hasMany(WorkOrderInput, { foreignKey: 'input_id' });
  WorkOrderInput.belongsTo(AgriculturalInput, { foreignKey: 'input_id' });
  WorkOrder.hasMany(WorkOrderMachinery, { foreignKey: 'work_order_id' });
  WorkOrderMachinery.belongsTo(WorkOrder, { foreignKey: 'work_order_id' });
  Machinery.hasMany(WorkOrderMachinery, { foreignKey: 'machinery_id' });
  WorkOrderMachinery.belongsTo(Machinery, { foreignKey: 'machinery_id' });

  Field.hasMany(RainfallEvent, { foreignKey: 'field_id' });
  RainfallEvent.belongsTo(Field, { foreignKey: 'field_id' });
  Field.hasMany(IrrigationEvent, { foreignKey: 'field_id' });
  IrrigationEvent.belongsTo(Field, { foreignKey: 'field_id' });
  Field.hasMany(SatelliteLayer, { foreignKey: 'field_id' });
  SatelliteLayer.belongsTo(Field, { foreignKey: 'field_id' });

  ReportTemplate.hasMany(ReportRun, { foreignKey: 'report_template_id' });
  ReportRun.belongsTo(ReportTemplate, { foreignKey: 'report_template_id' });
  SyncBatch.hasMany(SyncOperation, { foreignKey: 'sync_batch_id' });
  SyncOperation.belongsTo(SyncBatch, { foreignKey: 'sync_batch_id' });
  User.hasMany(Notification, { foreignKey: 'user_id' });
  Notification.belongsTo(User, { foreignKey: 'user_id' });
}
