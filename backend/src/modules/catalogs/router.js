import { Router } from 'express';
import { CropType, CropVariety, Module, Role } from '../../models/index.js';
import { asyncHandler } from '../../utils/http.js';

export const catalogsRouter = Router();

catalogsRouter.get('/bootstrap', asyncHandler(async (req, res) => {
  const [modules, roles, cropTypes] = await Promise.all([
    Module.findAll({ order: [['code', 'ASC']], transaction: req.dbTransaction }),
    Role.findAll({ where: { scope: 'tenant' }, order: [['code', 'ASC']], transaction: req.dbTransaction }),
    CropType.findAll({
      include: [{ model: CropVariety }],
      order: [['name', 'ASC']],
      transaction: req.dbTransaction
    })
  ]);

  res.json({ modules, roles, cropTypes });
}));
