import { Router } from 'express';
import { z } from 'zod';
import { Op } from 'sequelize';
import { Campaign, CampaignField, CropType, CropVariety, Field } from '../../models/index.js';
import { requireEntitlement } from '../../infra/http/middlewares/entitlementGuard.js';
import { asyncHandler, HttpError, validate } from '../../utils/http.js';
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

// PostgreSQL DATE CHECK is the final safeguard; reject bad periods at the
// HTTP boundary so clients receive actionable 422 instead of a DB 500.
// DATEONLY values from Sequelize are date strings, while Zod returns Date.
function dateOrderValid(start, end) {
  return start == null || end == null ||
    new Date(end).getTime() >= new Date(start).getTime();
}

function assertChronology(start, end, field, description) {
  if (!dateOrderValid(start, end)) {
    throw new HttpError(422, description,
      { fieldErrors: { [field]: [description] } }, 'VALIDATION_ERROR');
  }
}

const campaignCreateSchema = campaignSchema.refine(
  value => dateOrderValid(value.starts_at, value.ends_at),
  { path: ['ends_at'], message: 'El fin de campaña debe ser igual o posterior al inicio.' }
);

const campaignFieldSchema = z.object({
  field_id: z.string().uuid(),
  crop_type_id: z.string().uuid(),
  crop_variety_id: z.string().uuid().optional().nullable(),
  planting_date: z.coerce.date().optional(),
  harvest_target_date: z.coerce.date().optional(),
  expected_yield: z.coerce.number().nonnegative().optional(),
  status: z.enum(['planned', 'active', 'harvested', 'closed']).default('planned')
});

// Both columns have valid independent FKs, but those FKs do not prove that the
// selected variety actually belongs to the selected crop. The global catalogs
// are read-only through the tenant API; validate the pair in the same request
// transaction before writing any company-scoped campaign field.
async function assertCropVarietyForCampaign(req, cropTypeId, varietyId) {
  const crop = await CropType.findByPk(cropTypeId, {
    attributes: ['id'],
    transaction: req.dbTransaction
  });
  if (!crop) {
    throw new HttpError(422, 'Cultivo de campaña no válido.',
      undefined, 'CAMPAIGN_CROP_TYPE_NOT_FOUND');
  }
  if (varietyId != null) {
    const matchingVariety = await CropVariety.findOne({
      where: { id: varietyId, crop_type_id: cropTypeId },
      attributes: ['id'],
      transaction: req.dbTransaction
    });
    if (!matchingVariety) {
      throw new HttpError(422, 'La variedad no pertenece al cultivo seleccionado.',
        undefined, 'CAMPAIGN_CROP_VARIETY_MISMATCH');
    }
  }
}

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

campaignsRouter.post('/', requireCapability('campaigns.write'), validate(campaignCreateSchema), asyncHandler(async (req, res) => {
  const campaign = await Campaign.create(req.body, { transaction: req.dbTransaction });
  res.status(201).json({ data: campaign });
}));

campaignsRouter.post('/:campaignId/fields', requireCapability('campaigns.write'), validate(campaignFieldSchema), asyncHandler(async (req, res) => {
  const [campaign, field] = await Promise.all([
    Campaign.findOne({
      where: { id: req.params.campaignId, tenant_id: req.tenantId },
      attributes: ['id'],
      transaction: req.dbTransaction
    }),
    Field.findOne({
      where: { id: req.body.field_id, tenant_id: req.tenantId },
      attributes: ['id'],
      transaction: req.dbTransaction
    })
  ]);
  if (!campaign) throw new HttpError(404, 'Campaña no encontrada.', undefined, 'CAMPAIGN_NOT_FOUND');
  if (!field) throw new HttpError(404, 'Lote no encontrado.', undefined, 'CAMPAIGN_FIELD_NOT_FOUND');
  await assertCropVarietyForCampaign(req, req.body.crop_type_id, req.body.crop_variety_id);
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
  // A partial PATCH can invalidate a valid persisted interval by moving just
  // one endpoint. Compare the effective pair before any database write.
  assertChronology(
    req.body.starts_at ?? campaign.starts_at,
    req.body.ends_at ?? campaign.ends_at,
    'ends_at',
    'El fin de campaña debe ser igual o posterior al inicio.'
  );
  await campaign.update(req.body, { transaction: req.dbTransaction });
  res.json({ data: campaign });
}));

campaignsRouter.patch('/:campaignId/fields/:cfId', requireCapability('campaigns.write'), validate(campaignFieldSchema.partial()), asyncHandler(async (req, res) => {
  const cf = await CampaignField.findOne({
    where: { id: req.params.cfId, campaign_id: req.params.campaignId },
    transaction: req.dbTransaction
  });
  if (!cf) return res.status(404).json({ error: { message: 'Campo de campaña no encontrado.' } });
  // campaign_fields.id is the stable identity used by scouting runs and work
  // orders; observations and orders record their field_id independently.
  // Moving the parent would silently reinterpret already recorded GPS work,
  // and checking only for existing children would leave a concurrent race.
  // Correct an erroneous lot by creating a new association instead.
  if (req.body.field_id && req.body.field_id !== cf.field_id) {
    throw new HttpError(409, 'No se puede cambiar el lote de una campaña existente.',
      undefined, 'CAMPAIGN_FIELD_IDENTITY_IMMUTABLE');
  }
  // PATCH can change either half of this relationship. Compare the effective
  // pair after applying the partial update, not just the fields sent today.
  if (req.body.crop_type_id !== undefined || req.body.crop_variety_id !== undefined) {
    const effectiveTypeId = req.body.crop_type_id ?? cf.crop_type_id;
    const effectiveVarietyId = req.body.crop_variety_id !== undefined
      ? req.body.crop_variety_id
      : cf.crop_variety_id;
    await assertCropVarietyForCampaign(req, effectiveTypeId, effectiveVarietyId);
  }
  await cf.update(req.body, { transaction: req.dbTransaction });
  res.json({ data: cf });
}));
