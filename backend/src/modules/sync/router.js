import { Router } from 'express';
import { z } from 'zod';
import { SyncBatch, SyncOperation } from '../../models/index.js';
import { asyncHandler, validate } from '../../utils/http.js';

export const syncRouter = Router();

const operationSchema = z.object({
  entity_type: z.string().min(2).max(80),
  entity_client_id: z.string().max(120).optional(),
  operation: z.enum(['create', 'update', 'delete']),
  payload: z.record(z.any()).default({})
});

const batchSchema = z.object({
  client_id: z.string().min(2).max(120),
  device_id: z.string().max(120).optional(),
  operations: z.array(operationSchema).min(1).max(500)
});

syncRouter.post('/batches', validate(batchSchema), asyncHandler(async (req, res) => {
  const batch = await SyncBatch.create({
    client_id: req.body.client_id,
    device_id: req.body.device_id,
    submitted_by: req.auth.user.id,
    status: 'received'
  }, { transaction: req.dbTransaction });

  const operations = await SyncOperation.bulkCreate(req.body.operations.map((operation) => ({
    ...operation,
    sync_batch_id: batch.id
  })), { transaction: req.dbTransaction });

  res.status(202).json({ data: { batch, operations } });
}));

syncRouter.get('/batches', asyncHandler(async (req, res) => {
  const batches = await SyncBatch.findAll({
    include: [{ model: SyncOperation }],
    order: [['received_at', 'DESC']],
    transaction: req.dbTransaction
  });
  res.json({ data: batches });
}));
