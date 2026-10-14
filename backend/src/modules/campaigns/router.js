import { Router } from 'express';
import { z } from 'zod';
import { Op } from 'sequelize';
import { Campaign, CampaignField, CropType, CropVariety, Field } from '../../models/index.js';
import { requireEntitlement } from '../../infra/http/middlewares/entitlementGuard.js';
import { asyncHandler, validate } from '../../utils/http.js';
import { requireCapability } from '../../infra/http/middlewares/requireCapability.js';
import { assignedFieldIds } from '../scouting/scoutFieldScope.js';

export const campaignsRouter = Router();

campaignsRouter.use(requireEntitlement('campaigns'));

const campaignSchema = z.object({
  name: z.string().min(2).max(160),
  season_year: z.coerce.number().int().min(2000),
  starts_at: z.coerce.date(),
  ends_at: z.coerce.date().optional(),
  status: z.enum(['planned', 'active', 'closed', 'archived']).default('planned')
});

const campaignFieldSchema = z.object({
  field_id: z.string().uuid(),
  crop_type_id: z.string().uuid(),
  crop_variety_id: z.string().uuid().optional().nullable(),
  planting_date: z.coerce.date().optional(),
  harvest_target_date: z.coerce.date().optional(),
  expected_yield: z.coerce.number().nonnegative().optional(),
  status: z.enum(['planned', 'active', 'harvested', 'closed']).default('planned')
});

campaignsRouter.get('/', requireCapability('campaigns.read'), asyncHandler(async (req, res) => {
  const scopedFields = await assignedFieldIds(req);
  const scopedCampaignFields = scopedFields === null ? null : await CampaignField.findAll({
    where: { field_id: { [Op.in]: scopedFields } },
    attributes: ['campaign_id'],
    transaction: req.dbTransaction
  });
  const campaigns = await Campaign.findAll({
    ...(scopedCampaignFields === null ? {} : {
      where: { id: { [Op.in]: scopedCampaignFields.map((item) => item.campaign_id) } }
    }),
    include: [{
      model: CampaignField,
      ...(scopedFields === null ? {} : { where: { field_id: { [Op.in]: scopedFields } }, required: true }),
      include: [
        { model: Field, attributes: ['id', 'name', 'area_hectares'] },
        { model: CropType, attributes: ['id', 'name', 'code'] }
      ]
    }],
    order: [['starts_at', 'DESC']],
    transaction: req.dbTransaction
  });
  res.json({ data: campaigns });
}));

campaignsRouter.post('/', requireCapability('campaigns.write'), validate(campaignSchema), asyncHandler(async (req, res) => {
  const campaign = await Campaign.create(req.body, { transaction: req.dbTransaction });
  res.status(201).json({ data: campaign });
}));

campaignsRouter.post('/:campaignId/fields', requireCapability('campaigns.write'), validate(campaignFieldSchema), asyncHandler(async (req, res) => {
  const campaignField = await CampaignField.create({
    ...req.body,
    campaign_id: req.params.campaignId
  }, { transaction: req.dbTransaction });
  res.status(201).json({ data: campaignField });
}));

// All campaign-fields (for scouting run selectors etc.)
campaignsRouter.get('/fields', requireCapability('campaigns.read'), asyncHandler(async (req, res) => {
  const scopedFields = await assignedFieldIds(req);
  const cfs = await CampaignField.findAll({
    ...(scopedFields === null ? {} : { where: { field_id: { [Op.in]: scopedFields } } }),
    include: [
      { model: Field, attributes: ['id', 'name', 'area_hectares'] },
      { model: CropType, attributes: ['id', 'name', 'code'] },
      { model: Campaign, attributes: ['id', 'name', 'season_year', 'status'] }
    ],
    order: [['created_at', 'DESC']],
    transaction: req.dbTransaction
  });
  res.json({ data: cfs });
}));

campaignsRouter.get('/:id', requireCapability('campaigns.read'), asyncHandler(async (req, res) => {
  const scopedFields = await assignedFieldIds(req);
  const campaign = await Campaign.findOne({
    where: { id: req.params.id },
    include: [{
      model: CampaignField,
      ...(scopedFields === null ? {} : { where: { field_id: { [Op.in]: scopedFields } }, required: true }),
      include: [
        { model: Field },
        { model: CropType },
        { model: CropVariety }
      ]
    }],
    transaction: req.dbTransaction
  });
  if (!campaign) return res.status(404).json({ error: { message: 'Campaña no encontrada.' } });
  res.json({ data: campaign });
}));

campaignsRouter.patch('/:id', requireCapability('campaigns.write'), validate(campaignSchema.partial()), asyncHandler(async (req, res) => {
  const campaign = await Campaign.findByPk(req.params.id, { transaction: req.dbTransaction });
  if (!campaign) return res.status(404).json({ error: { message: 'Campaña no encontrada.' } });
  await campaign.update(req.body, { transaction: req.dbTransaction });
  res.json({ data: campaign });
}));

campaignsRouter.patch('/:campaignId/fields/:cfId', requireCapability('campaigns.write'), validate(campaignFieldSchema.partial()), asyncHandler(async (req, res) => {
  const cf = await CampaignField.findOne({
    where: { id: req.params.cfId, campaign_id: req.params.campaignId },
    transaction: req.dbTransaction
  });
  if (!cf) return res.status(404).json({ error: { message: 'Campo de campaña no encontrado.' } });
  await cf.update(req.body, { transaction: req.dbTransaction });
  res.json({ data: cf });
}));
