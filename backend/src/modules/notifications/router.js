import { Router } from 'express';
import { Notification } from '../../models/index.js';
import { asyncHandler } from '../../utils/http.js';

export const notificationsRouter = Router();

notificationsRouter.get('/', asyncHandler(async (req, res) => {
  const notifications = await Notification.findAll({
    where: { user_id: req.auth.user.id },
    order: [['created_at', 'DESC']],
    limit: 50,
    transaction: req.dbTransaction
  });
  res.json({ data: notifications });
}));

notificationsRouter.patch('/:id/read', asyncHandler(async (req, res) => {
  const notification = await Notification.findByPk(req.params.id, { transaction: req.dbTransaction });
  if (!notification) return res.status(404).json({ error: { message: 'Notificación no encontrada.' } });
  await notification.update({ read_at: new Date() }, { transaction: req.dbTransaction });
  res.json({ data: notification });
}));
