import { Router } from 'express';
import { z } from 'zod';
import { Op } from 'sequelize';
import { Membership, Team, TeamMember, User } from '../../models/index.js';
import { requireEntitlement } from '../../infra/http/middlewares/entitlementGuard.js';
import { asyncHandler, HttpError, validate } from '../../utils/http.js';
import { requireCapability } from '../../infra/http/middlewares/requireCapability.js';

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

teamsRouter.get('/', requireCapability('teams.read'), asyncHandler(async (req, res) => {
  const teams = await Team.findAll({
    include: [{
      model: TeamMember,
      include: [{ model: User, attributes: ['id', 'full_name', 'email'],
        where: { status: 'active' }, required: true }]
    }],
    order: [['name', 'ASC']],
    transaction: req.dbTransaction
  });
  // A tenant membership can later be blocked without deleting its historical
  // TeamMember FK. Never expose the former member's name/email in active teams.
  const userIds = [...new Set(teams.flatMap(team =>
    (team.TeamMembers ?? []).map(member => member.user_id)))];
  const liveMemberships = userIds.length === 0 ? [] : await Membership.findAll({
    where: { tenant_id: req.tenantId, user_id: { [Op.in]: userIds }, status: 'active' },
    attributes: ['user_id'],
    transaction: req.dbTransaction
  });
  const activeUsers = new Set(liveMemberships.map(member => member.user_id));
  res.json({ data: teams.map(team => {
    const item = team.toJSON();
    item.TeamMembers = (item.TeamMembers ?? []).filter(member => activeUsers.has(member.user_id));
    return item;
  }) });
}));

teamsRouter.post('/', requireCapability('teams.write'), validate(teamSchema), asyncHandler(async (req, res) => {
  const team = await Team.create(req.body, { transaction: req.dbTransaction });
  res.status(201).json({ data: team });
}));

teamsRouter.post('/:id/members', requireCapability('teams.write'), validate(memberSchema), asyncHandler(async (req, res) => {
  const team = await Team.findOne({
    where: { id: req.params.id, tenant_id: req.tenantId },
    attributes: ['id'],
    transaction: req.dbTransaction
  });
  if (!team) throw new HttpError(404, 'Equipo no encontrado.', undefined, 'TEAM_NOT_FOUND');
  const membership = await Membership.findOne({
    where: { tenant_id: req.tenantId, user_id: req.body.user_id, status: 'active' },
    include: [{
      model: User, attributes: ['id'], where: { status: 'active' }, required: true
    }],
    transaction: req.dbTransaction
  });
  if (!membership) {
    throw new HttpError(422, 'Elegí un integrante activo de esta empresa.',
      undefined, 'TEAM_MEMBER_NOT_ACTIVE');
  }
  // Network retries must not turn an already persisted roster entry into a 500,
  // nor silently overwrite the role of an existing member.
  const [member, created] = await TeamMember.findOrCreate({
    where: { tenant_id: req.tenantId, team_id: team.id, user_id: membership.user_id },
    defaults: { role_label: req.body.role_label },
    transaction: req.dbTransaction
  });
  if (!created && member.role_label !== req.body.role_label) {
    throw new HttpError(409, 'El integrante ya existe con otro rol.',
      undefined, 'TEAM_MEMBER_ROLE_CONFLICT');
  }
  res.status(created ? 201 : 200).json({ data: member });
}));
