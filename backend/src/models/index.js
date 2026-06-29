import { DataTypes } from 'sequelize';
import { sequelize, installTenantHooks } from '../core/db.js';
import { associateModels } from './associations.js';
import { defineUser } from './definitions/user.model.js';
import { definePlan } from './definitions/plan.model.js';
import { defineModule } from './definitions/module.model.js';
import { definePlanModule } from './definitions/planModule.model.js';
import { defineRole } from './definitions/role.model.js';
import { definePermission } from './definitions/permission.model.js';
import { defineRolePermission } from './definitions/rolePermission.model.js';
import { defineTenant } from './definitions/tenant.model.js';
import { defineMembership } from './definitions/membership.model.js';
import { defineTenantModule } from './definitions/tenantModule.model.js';
import { defineTenantIntegration } from './definitions/tenantIntegration.model.js';
import { definePlatformAuditLog } from './definitions/platformAuditLog.model.js';
import { defineTenantSeatUsage } from './definitions/tenantSeatUsage.model.js';
import { defineProducer } from './definitions/producer.model.js';
import { defineFarm } from './definitions/farm.model.js';
import { defineField } from './definitions/field.model.js';
import { defineCropType } from './definitions/cropType.model.js';
import { defineCropVariety } from './definitions/cropVariety.model.js';
import { defineCampaign } from './definitions/campaign.model.js';
import { defineCampaignField } from './definitions/campaignField.model.js';
import { defineScoutingRun } from './definitions/scoutingRun.model.js';
import { defineScoutingObservation } from './definitions/scoutingObservation.model.js';
import { defineEvidenceAsset } from './definitions/evidenceAsset.model.js';
import { defineWorkOrder } from './definitions/workOrder.model.js';
import { defineWorkOrderAssignee } from './definitions/workOrderAssignee.model.js';
import { defineRainfallEvent } from './definitions/rainfallEvent.model.js';
import { defineIrrigationEvent } from './definitions/irrigationEvent.model.js';
import { defineAuditEvent } from './definitions/auditEvent.model.js';
import { defineTeam } from './definitions/team.model.js';
import { defineTeamMember } from './definitions/teamMember.model.js';
import { defineMachinery } from './definitions/machinery.model.js';
import { defineAgriculturalInput } from './definitions/agriculturalInput.model.js';
import { defineWorkOrderInput } from './definitions/workOrderInput.model.js';
import { defineWorkOrderMachinery } from './definitions/workOrderMachinery.model.js';
import { defineSatelliteLayer } from './definitions/satelliteLayer.model.js';
import { defineReportTemplate } from './definitions/reportTemplate.model.js';
import { defineReportRun } from './definitions/reportRun.model.js';
import { defineSyncBatch } from './definitions/syncBatch.model.js';
import { defineSyncOperation } from './definitions/syncOperation.model.js';
import { defineNotification } from './definitions/notification.model.js';

export const User = defineUser(sequelize, DataTypes);
export const Plan = definePlan(sequelize, DataTypes);
export const Module = defineModule(sequelize, DataTypes);
export const PlanModule = definePlanModule(sequelize, DataTypes);
export const Role = defineRole(sequelize, DataTypes);
export const Permission = definePermission(sequelize, DataTypes);
export const RolePermission = defineRolePermission(sequelize, DataTypes);
export const Tenant = defineTenant(sequelize, DataTypes);
export const Membership = defineMembership(sequelize, DataTypes);
export const TenantModule = defineTenantModule(sequelize, DataTypes);
export const TenantIntegration = defineTenantIntegration(sequelize, DataTypes);
export const PlatformAuditLog = definePlatformAuditLog(sequelize, DataTypes);
export const TenantSeatUsage = defineTenantSeatUsage(sequelize, DataTypes);
export const Producer = defineProducer(sequelize, DataTypes);
export const Farm = defineFarm(sequelize, DataTypes);
export const Field = defineField(sequelize, DataTypes);
export const CropType = defineCropType(sequelize, DataTypes);
export const CropVariety = defineCropVariety(sequelize, DataTypes);
export const Campaign = defineCampaign(sequelize, DataTypes);
export const CampaignField = defineCampaignField(sequelize, DataTypes);
export const ScoutingRun = defineScoutingRun(sequelize, DataTypes);
export const ScoutingObservation = defineScoutingObservation(sequelize, DataTypes);
export const EvidenceAsset = defineEvidenceAsset(sequelize, DataTypes);
export const WorkOrder = defineWorkOrder(sequelize, DataTypes);
export const WorkOrderAssignee = defineWorkOrderAssignee(sequelize, DataTypes);
export const RainfallEvent = defineRainfallEvent(sequelize, DataTypes);
export const IrrigationEvent = defineIrrigationEvent(sequelize, DataTypes);
export const AuditEvent = defineAuditEvent(sequelize, DataTypes);
export const Team = defineTeam(sequelize, DataTypes);
export const TeamMember = defineTeamMember(sequelize, DataTypes);
export const Machinery = defineMachinery(sequelize, DataTypes);
export const AgriculturalInput = defineAgriculturalInput(sequelize, DataTypes);
export const WorkOrderInput = defineWorkOrderInput(sequelize, DataTypes);
export const WorkOrderMachinery = defineWorkOrderMachinery(sequelize, DataTypes);
export const SatelliteLayer = defineSatelliteLayer(sequelize, DataTypes);
export const ReportTemplate = defineReportTemplate(sequelize, DataTypes);
export const ReportRun = defineReportRun(sequelize, DataTypes);
export const SyncBatch = defineSyncBatch(sequelize, DataTypes);
export const SyncOperation = defineSyncOperation(sequelize, DataTypes);
export const Notification = defineNotification(sequelize, DataTypes);

export const models = {
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
  TenantIntegration,
  PlatformAuditLog,
  TenantSeatUsage,
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
  AuditEvent,
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
};

associateModels(models);
installTenantHooks();
