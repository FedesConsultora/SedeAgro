// Scoped browser-only recovery for a potentially committed work-order POST.
// Separate IDB database and AES-GCM AAD domain from campaigns, scouting and
// sensitive offline observation/photo drafts. No credentials are stored.
import { createEncryptedCreateJournal } from './encryptedCreateJournal.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TYPES = new Set([
  'application', 'sowing', 'fertilization', 'harvest',
  'irrigation', 'inspection', 'other'
]);
const PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);

const journal = createEncryptedCreateJournal({
  databaseName: 'sedeagro-work-order-recovery',
  aadDomain: 'sedeagro:work-order-recovery:v1:',
  validateBody: body =>
    UUID.test(body.field_id || '') &&
    (body.campaign_field_id == null || UUID.test(body.campaign_field_id)) &&
    TYPES.has(body.type) &&
    PRIORITIES.has(body.priority) &&
    typeof body.title === 'string' &&
    body.title.trim().length >= 2 && body.title.length <= 180 &&
    (body.status === undefined || body.status === 'draft') &&
    (body.instructions === undefined || typeof body.instructions === 'string') &&
    (body.due_at === undefined || body.due_at === null ||
      (typeof body.due_at === 'string' &&
        Number.isFinite(Date.parse(body.due_at)) &&
        new Date(body.due_at).toISOString() === body.due_at))
});

export const readWorkOrderRecovery = journal.read;
export const saveWorkOrderRecovery = journal.save;
export const discardWorkOrderRecovery = journal.discard;
