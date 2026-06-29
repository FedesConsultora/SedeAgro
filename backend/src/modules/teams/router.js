import { Router } from 'express';
import { z } from 'zod';
import { Team, TeamMember, User } from '../../models/index.js';
import { requireEntitlement } from '../../infra/http/middlewares/entitlementGuard.js';
import { asyncHandler, validate } from '../../utils/http.js';

export const teamsRouter = Router();

teamsRouter.use(requireEntitlement('org'));

const teamSchema = z.object({
  name: z.string().min(2).max(160),
  scope: z.enum(['field_ops', 'agronomy', 'contractor', 'client', 'support']).default('field_ops'),
  farm_id: z.string().uuid().optional().nullable(),
  notes: z.string().optional()
});

const memberSchema = z.object({
  user_id: z.string().uuid(),
  role_label: z.string().max(80).default('member')
});

teamsRouter.get('/', asyncHandler(async (req, res) => {
  const teams = await Team.findAll({
    include: [{ model: TeamMember, include: [{ model: User, attributes: ['id', 'full_name', 'email'] }] }],
    order: [['name', 'ASC']],
    transaction: req.dbTransaction
  });
  res.json({ data: teams });
}));

teamsRouter.post('/', validate(teamSchema), asyncHandler(async (req, res) => {
  const team = await Team.create(req.body, { transaction: req.dbTransaction });
  res.status(201).json({ data: team });
}));

teamsRouter.post('/:id/members', validate(memberSchema), asyncHandler(async (req, res) => {
  const member = await TeamMember.create({
    ...req.body,
    team_id: req.params.id
  }, { transaction: req.dbTransaction });
  res.status(201).json({ data: member });
}));
