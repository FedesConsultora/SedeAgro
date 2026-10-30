// Same-origin tabs share IndexedDB but not JS module memory. This metadata
// only orders cooperative vault mutations: NO tenant/user/session identity,
// credentials, ciphertext, offline draft ID or authorization are persisted.
export const VAULT_MUTATION_EPOCH_KEY = 'sedeagro.offline-vault-epoch-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const unavailable = () => new Error(
  'No se puede coordinar el acceso offline entre pestañas. Habilitá el almacenamiento del sitio.'
);

function sharedStorage() {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch { throw unavailable(); }
  // Node-only deterministic vault tests have no browser storage. Browsers
  // fail closed instead of silently losing cross-tab ordering.
  if (typeof window !== 'undefined') throw unavailable();
  return null;
}

export function readSharedVaultEpoch(storage = sharedStorage()) {
  if (!storage) return null;
  let value;
  try { value = storage.getItem(VAULT_MUTATION_EPOCH_KEY); }
  catch { throw unavailable(); }
  if (value !== null && !UUID.test(value)) throw unavailable();
  return value;
}

export function claimSharedVaultEpoch(
  storage = sharedStorage(), cryptoSource = globalThis.crypto
) {
  if (!storage) return null; // Node-only controlled tests
  if (typeof cryptoSource?.randomUUID !== 'function') throw unavailable();
  const epoch = cryptoSource.randomUUID();
  if (!UUID.test(epoch)) throw unavailable();
  try { storage.setItem(VAULT_MUTATION_EPOCH_KEY, epoch); }
  catch { throw unavailable(); }
  assertSharedVaultEpoch(epoch, storage);
  return epoch;
}

export function assertSharedVaultEpoch(expected, storage = sharedStorage()) {
  if (readSharedVaultEpoch(storage) !== expected) {
    throw new Error('El acceso local cambió en otra pestaña. Volvé a verificarlo.');
  }
}
