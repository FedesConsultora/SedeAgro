import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import {
  CampaignField, ScoutingObservation, ScoutingRun, SyncBatch, SyncOperation
} from '../../models/index.js';
import { asyncHandler, HttpError, validate } from '../../utils/http.js';
import { requireCapability } from '../../infra/http/middlewares/requireCapability.js';
import { requireEntitlement } from '../../infra/http/middlewares/entitlementGuard.js';
import { assertScoutingWritable } from '../scouting/scoutingPolicy.js';
import { recordScoutingAudit } from '../scouting/audit.js';

export const syncRouter = Router();

const pointSchema = z.object({
  type: z.literal('Point'),
  coordinates: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])
}).strict();
const observationPayloadSchema = z.object({
  scouting_run_id: z.string().uuid(),
  observation_type: z.enum(['weed', 'pest', 'disease', 'phenology', 'nutrition', 'water', 'general']),
  severity: z.enum(['low', 'medium', 'high', 'critical']).default('low'),
  point: pointSchema.optional(),
  notes: z.string().min(1).max(10000),
  observed_at: z.coerce.date().optional()
}).strict();

// Fail closed: supporting an entity in the envelope is not the same as
// supporting its mutation. Unknown entity types/verbs are rejected, not queued.
const operationSchema = z.object({
  entity_type: z.literal('scouting_observation'),
  entity_client_id: z.string().uuid(),
  operation: z.literal('create'),
  payload: observationPayloadSchema
}).strict();

const batchSchema = z.object({
  client_id: z.string().min(2).max(120),
  device_id: z.string().max(120).optional(),
  idempotency_key: z.string().uuid(),
  operations: z.array(operationSchema).min(1).max(50)
}).strict().superRefine((batch, context) => {
  const seen = new Set();
  for (const [index, op] of batch.operations.entries()) {
    if (seen.has(op.entity_client_id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['operations', index, 'entity_client_id'],
        message: 'Cada operación del lote necesita un identificador de cliente diferente.'
      });
    }
    seen.add(op.entity_client_id);
  }
});

const batchAttributes = [
  'id', 'client_id', 'device_id', 'submitted_by', 'received_at',
  'status', 'processed_at', 'conflict_count', 'idempotency_key'
];
const operationAttributes = [
  'id', 'entity_type', 'entity_client_id', 'operation', 'status', 'error', 'result'
];
const includeOperations = [{ model: SyncOperation, attributes: operationAttributes }];

function fingerprint(body) {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

function resultView(batch, operations) {
  return {
    id: batch.id,
    client_id: batch.client_id,
    device_id: batch.device_id,
    status: batch.status,
    idempotency_key: batch.idempotency_key,
    received_at: batch.received_at,
    processed_at: batch.processed_at,
    operations: operations.map((item) => ({
      id: item.id,
      entity_client_id: item.entity_client_id,
      status: item.status,
      result: item.result
    }))
  };
}

// The receipt is already processed when HTTP success is transmitted.
// All writes, including operation results and audits, commit atomically.
syncRouter.post('/batches', requireCapability('sync.submit'), requireEntitlement('scouting'),
  validate(batchSchema), asyncHandler(async (req, res) => {
    const tx = req.dbTransaction;
    const input = req.body;
    const digest = fingerprint(input);
    const [batch, created] = await SyncBatch.findOrCreate({
      where: {
        tenant_id: req.tenantId,
        submitted_by: req.auth.user.id,
        idempotency_key: input.idempotency_key
      },
      defaults: {
        client_id: input.client_id,
        device_id: input.device_id,
        submitted_by: req.auth.user.id,
        idempotency_key: input.idempotency_key,
        request_hash: digest,
        status: 'received'
      },
      transaction: tx
    });

    if (!created) {
      if (batch.request_hash !== digest) {
        throw new HttpError(409, 'Esta clave de sincronización ya se utilizó con otro contenido.',
          undefined, 'SYNC_IDEMPOTENCY_CONFLICT');
      }
      if (batch.status !== 'processed') {
        throw new HttpError(409, 'El lote todavía no tiene un resultado definitivo.',
          undefined, 'SYNC_BATCH_NOT_PROCESSED');
      }
      const original = await SyncOperation.findAll({
        where: { sync_batch_id: batch.id },
        attributes: operationAttributes,
        order: [['id', 'ASC']],
        transaction: tx
      });
      res.json({ data: resultView(batch, original), replayed: true });
      return;
    }

    // Lock rows in a deterministic order across concurrent offline batches.
    const runIds = [...new Set(input.operations.map((op) => op.payload.scouting_run_id))].sort();
    const runs = new Map();
    for (const runId of runIds) {
      const run = await ScoutingRun.findByPk(runId, {
        transaction: tx, lock: tx.LOCK.UPDATE
      });
      if (!run) {
        throw new HttpError(404, 'La recorrida ya no existe o no está disponible.',
          undefined, 'SYNC_RUN_NOT_FOUND');
      }
      assertScoutingWritable(req.auth, run);
      const campaignField = await CampaignField.findByPk(run.campaign_field_id, { transaction: tx });
      if (!campaignField) {
        throw new HttpError(409, 'El lote de campaña ya no está disponible.',
          undefined, 'SYNC_FIELD_NOT_FOUND');
      }
      runs.set(runId, { run, fieldId: campaignField.field_id });
    }

    const applied = [];
    for (const operation of input.operations) {
      const { run, fieldId } = runs.get(operation.payload.scouting_run_id);
      const { scouting_run_id: _runId, ...observation } = operation.payload;
      const createdObservation = await ScoutingObservation.create({
        ...observation,
        scouting_run_id: run.id,
        field_id: fieldId,
        observed_by: req.auth.user.id
      }, { transaction: tx });
      const savedOperation = await SyncOperation.create({
        sync_batch_id: batch.id,
        entity_type: operation.entity_type,
        entity_client_id: operation.entity_client_id,
        operation: operation.operation,
        payload: operation.payload,
        status: 'applied',
        result: {
          observation_id: createdObservation.id,
          scouting_run_id: run.id,
          field_id: fieldId
        }
      }, { transaction: tx });
      await recordScoutingAudit(req, {
        runId: run.id,
        action: 'scouting.observation.synced',
        after: {
          observation_id: createdObservation.id,
          field_id: fieldId,
          sync_batch_id: batch.id,
          sync_operation_id: savedOperation.id,
          severity: createdObservation.severity,
          observation_type: createdObservation.observation_type
        }
      });
      applied.push(savedOperation);
    }

    await batch.update({
      status: 'processed', processed_at: new Date(), conflict_count: 0
    }, { transaction: tx });
    res.status(201).json({ data: resultView(batch, applied), replayed: false });
  }));

syncRouter.get('/my-batches', requireCapability('sync.submit'), asyncHandler(async (req, res) => {
  const batches = await SyncBatch.findAll({
    where: { submitted_by: req.auth.user.id },
    attributes: batchAttributes,
    include: includeOperations,
    order: [['received_at', 'DESC']],
    limit: 100,
    transaction: req.dbTransaction
  });
  res.json({ data: batches });
}));

syncRouter.get('/batches', requireCapability('sync.read'), asyncHandler(async (req, res) => {
  const batches = await SyncBatch.findAll({
    attributes: batchAttributes,
    include: includeOperations,
    order: [['received_at', 'DESC']],
    limit: 100,
    transaction: req.dbTransaction
  });
  res.json({ data: batches });
}));
