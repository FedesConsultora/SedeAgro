import { ProducerAccessGrant } from '../../models/index.js';

// Only producer_viewer uses resource grants. Tenant administrators,
// coordinators and scouts retain their explicit role-level GIS privileges.
export function isProducerViewer(req) {
  return req.auth?.role?.code === 'producer_viewer';
}

export async function grantedProducerIds(req) {
  if (!isProducerViewer(req)) return null;
  const grants = await ProducerAccessGrant.findAll({
    where: { tenant_id: req.tenantId, user_id: req.auth.user.id },
    attributes: ['producer_id'],
    transaction: req.dbTransaction
  });
  return grants.map((item) => item.producer_id);
}
