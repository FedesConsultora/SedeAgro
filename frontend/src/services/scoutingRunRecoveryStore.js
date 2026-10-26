// Separate IDB database/AAD from campaign creates and observation drafts.
// No cookie, JWT or credentials ever enter this persistent journal.
import { createEncryptedCreateJournal } from './encryptedCreateJournal.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const journal = createEncryptedCreateJournal({
  databaseName: 'sedeagro-scouting-run-recovery',
  aadDomain: 'sedeagro:scouting-run-recovery:v1:',
  validateBody: body => UUID.test(body.campaign_field_id || '') &&
    (body.assigned_to == null || UUID.test(body.assigned_to)) &&
    (body.scheduled_at === undefined ||
      (typeof body.scheduled_at === 'string' &&
        Number.isFinite(Date.parse(body.scheduled_at)))) &&
    ['planned', 'in_progress'].includes(body.status) &&
    (body.summary === undefined ||
      (typeof body.summary === 'string' && body.summary.length <= 5000))
});

export const readScoutingRunRecovery = journal.read;
export const saveScoutingRunRecovery = journal.save;
export const discardScoutingRunRecovery = journal.discard;
