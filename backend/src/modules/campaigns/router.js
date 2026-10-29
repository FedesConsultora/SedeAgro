import { Router } from 'express';
import { z } from 'zod';
import { Op } from 'sequelize';
import { Campaign, CampaignField, CropType, CropVariety, Field } from '../../models/index.js';
import { requireEntitlement } from '../../infra/http/middlewares/entitlementGuard.js';
import { asyncHandler, HttpError, validate } from '../../utils/http.js';
import { requireCapability } from '../../infra/http/middlewares/requireCapability.js';
import { assignedFieldIds } from '../scouting/scoutFieldScope.js';
import { reserveCampaignCreate, completeCampaignCreate } from './createIdempotency.js';
import { reserveCampaignFieldAssign, completeCampaignFieldAssign } from './fieldAssignIdempotency.js';

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

const campaignCreateSchema = campaignSchema.extend({
  client_request_id: z.string().uuid().optional()
}).refine(
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

const campaignFieldCreateSchema = campaignFieldSchema.extend({
  client_request_id: z.string().uuid().optional()
}).refine(
  value => dateOrderValid(value.planting_date, value.harvest_target_date),
  { path: ['harvest_target_date'],
    message: 'La cosecha objetivo no puede ser anterior a la siembra.' }
);

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
  // The capability check and RLS transaction precede receipt lookup. A key
  // alone cannot read someone else's campaign even if its UUID is known.
  const reservation = await reserveCampaignCreate(req, req.body);
  res.set('Cache-Control', 'private, no-store');
  if (reservation.kind === 'replay') {
    return res.status(200).json({ data: reservation.campaign, replayed: true });
  }
  const { client_request_id: _clientRequestId, ...campaignInput } = req.body;
  const campaign = await Campaign.create(campaignInput, { transaction: req.dbTransaction });
  await completeCampaignCreate(req, reservation, campaign.id);
  res.status(201).json({ data: campaign,
    ...(reservation.kind === 'new' ? { replayed: false } : {}) });
}));

campaignsRouter.post('/:campaignId/fields', requireCapability('campaigns.write'), validate(campaignFieldCreateSchema), asyncHandler(async (req, res) => {
  // The parent campaign and field must belong to the authenticated tenant
  // even for a replay. A client UUID never grants cross-company access.
  if (!z.string().uuid().safeParse(req.params.campaignId).success) {
    throw new HttpError(422, 'Identificador de campaña inválido.', undefined, 'CAMPAIGN_ID_INVALID');
  }
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
  res.set('Cache-Control', 'private, no-store');
  const reservation = await reserveCampaignFieldAssign(req, campaign.id, req.body);
  if (reservation.kind === 'replay') {
    return res.status(200).json({ data: reservation.campaignField, replayed: true });
  }
  await assertCropVarietyForCampaign(req, req.body.crop_type_id, req.body.crop_variety_id);
  const { client_request_id: _clientRequestId, ...fieldInput } = req.body;
  // The existing tenant+campaign+field unique index rejects a second
  // assignment with another key. findOrCreate returns a scoped 409 instead
  // of leaking a UNIQUE constraint as an unhelpful HTTP 500.
  const [campaignField, created] = await CampaignField.findOrCreate({
    where: { tenant_id: req.tenantId, campaign_id: campaign.id, field_id: field.id },
    defaults: fieldInput,
    transaction: req.dbTransaction
  });
  if (!created) {
    throw new HttpError(409, 'El lote ya está asignado a esta campaña. Revisá el listado.',
      undefined, 'CAMPAIGN_FIELD_ALREADY_ASSIGNED');
  }
  await completeCampaignFieldAssign(req, reservation, campaignField.id);
  res.status(201).json({ data: campaignField,
    ...(reservation.kind === 'new' ? { replayed: false } : {}) });
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
  // Check the effective dates even when PATCH changes only one endpoint.
  // A trusted DB CHECK remains in place for concurrent or direct SQL writes.
  assertChronology(
    req.body.planting_date ?? cf.planting_date,
    req.body.harvest_target_date ?? cf.harvest_target_date,
    'harvest_target_date',
    'La cosecha objetivo no puede ser anterior a la siembra.'
  );
  await cf.update(req.body, { transaction: req.dbTransaction });
  res.json({ data: cf });
}));
