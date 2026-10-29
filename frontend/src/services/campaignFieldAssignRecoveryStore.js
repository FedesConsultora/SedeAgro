// A field assignment can COMMIT while its HTTP response is lost. Persist
// exactly one immutable request per actor+tenant+campaign, AES-GCM encrypted,
// before dispatch. Independent IDB store/key from campaign/work-order creates.
import { createEncryptedCreateJournal } from './encryptedCreateJournal.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUSES = new Set(['planned', 'active', 'harvested', 'closed']);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const journal = createEncryptedCreateJournal({
  databaseName: 'sedeagro-campaign-field-assign-recovery',
  aadDomain: 'sedeagro:campaign-field-assign-recovery:v1:',
  validateBody: body => UUID.test(body.field_id || '') &&
    UUID.test(body.crop_type_id || '') &&
    (body.crop_variety_id == null || UUID.test(body.crop_variety_id)) &&
    STATUSES.has(body.status) &&
    ['planting_date', 'harvest_target_date'].every(key =>
      body[key] === undefined || body[key] === null ||
      (typeof body[key] === 'string' && DATE.test(body[key]))) &&
    (body.expected_yield === undefined ||
      (typeof body.expected_yield === 'number' && Number.isFinite(body.expected_yield) &&
        body.expected_yield >= 0 && body.expected_yield <= 9999999999.99))
});

export const readCampaignFieldAssignRecovery = journal.read;
export const saveCampaignFieldAssignRecovery = journal.save;
export const discardCampaignFieldAssignRecovery = journal.discard;
