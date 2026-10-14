import { Op } from 'sequelize';
import { CampaignField, Field, ScoutingRun } from '../../models/index.js';

// A scout's GIS/campaign read scope is derived exclusively from explicit run
// assignments. Empty scope is deny-by-default, never "all tenant fields".
export function isScout(req) {
  return req.auth?.role?.code === 'scout';
}

export async function assignedFieldIds(req) {
  if (!isScout(req)) return null;
  const assignments = await ScoutingRun.findAll({
    where: { assigned_to: req.auth.user.id },
    attributes: ['campaign_field_id'],
    transaction: req.dbTransaction
  });
  const campaignFieldIds = [...new Set(assignments.map((run) => run.campaign_field_id))];
  if (!campaignFieldIds.length) return [];
  const fields = await CampaignField.findAll({
    where: { id: { [Op.in]: campaignFieldIds } },
    attributes: ['field_id'],
    transaction: req.dbTransaction
  });
  return [...new Set(fields.map((field) => field.field_id))];
}

export async function assignedFarmIds(req) {
  const ids = await assignedFieldIds(req);
  if (ids === null) return null;
  if (!ids.length) return [];
  const fields = await Field.findAll({
    where: { id: { [Op.in]: ids } },
    attributes: ['farm_id'],
    transaction: req.dbTransaction
  });
  return [...new Set(fields.map((field) => field.farm_id))];
}
