import { Router } from 'express';
import { z } from 'zod';
import { Campaign, CampaignField, CropType, CropVariety, Field } from '../../models/index.js';
import { requireEntitlement } from '../../infra/http/middlewares/entitlementGuard.js';
import { asyncHandler, validate } from '../../utils/http.js';

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

campaignsRouter.get('/', asyncHandler(async (req, res) => {
  const campaigns = await Campaign.findAll({
    include: [{
      model: CampaignField,
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

campaignsRouter.post('/', validate(campaignSchema), asyncHandler(async (req, res) => {
  const campaign = await Campaign.create(req.body, { transaction: req.dbTransaction });
  res.status(201).json({ data: campaign });
}));

campaignsRouter.post('/:campaignId/fields', validate(campaignFieldSchema), asyncHandler(async (req, res) => {
  const campaignField = await CampaignField.create({
    ...req.body,
    campaign_id: req.params.campaignId
  }, { transaction: req.dbTransaction });
  res.status(201).json({ data: campaignField });
}));

campaignsRouter.get('/:id', asyncHandler(async (req, res) => {
  const campaign = await Campaign.findByPk(req.params.id, {
    include: [{
      model: CampaignField,
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

campaignsRouter.patch('/:id', validate(campaignSchema.partial()), asyncHandler(async (req, res) => {
  const campaign = await Campaign.findByPk(req.params.id, { transaction: req.dbTransaction });
  if (!campaign) return res.status(404).json({ error: { message: 'Campaña no encontrada.' } });
  await campaign.update(req.body, { transaction: req.dbTransaction });
  res.json({ data: campaign });
}));

// All campaign-fields (for scouting run selectors etc.)
campaignsRouter.get('/fields', asyncHandler(async (req, res) => {
  const cfs = await CampaignField.findAll({
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

campaignsRouter.patch('/:campaignId/fields/:cfId', validate(campaignFieldSchema.partial()), asyncHandler(async (req, res) => {
  const cf = await CampaignField.findOne({
    where: { id: req.params.cfId, campaign_id: req.params.campaignId },
    transaction: req.dbTransaction
  });
  if (!cf) return res.status(404).json({ error: { message: 'Campo de campaña no encontrado.' } });
  await cf.update(req.body, { transaction: req.dbTransaction });
  res.json({ data: cf });
}));
