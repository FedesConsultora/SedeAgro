// Installed campaign journal compatibility: unchanged DB, object stores,
// encryption domain, and pending request shape across the refactor.
import { createEncryptedCreateJournal } from './encryptedCreateJournal.js';

const journal = createEncryptedCreateJournal({
  databaseName: 'sedeagro-campaign-recovery',
  aadDomain: 'sedeagro:campaign-recovery:v1:',
  validateBody: body => typeof body.name === 'string' && body.name.length >= 2 &&
    Number.isInteger(body.season_year) && typeof body.starts_at === 'string' &&
    typeof body.status === 'string' &&
    (body.ends_at === undefined || typeof body.ends_at === 'string')
});

export const readCampaignRecovery = journal.read;
export const saveCampaignRecovery = journal.save;
export const discardCampaignRecovery = journal.discard;
