// Shared, scope-bound encrypted creation journal. The DB name and AAD domain
// are caller-specific. Never change an installed domain or object-store schema:
// users may have a committed request from an earlier version awaiting recovery.
// Browser-only recovery journal for campaign POSTs that might have committed.
// A non-extractable AES-GCM key lives in IndexedDB alongside the ciphertext;
// no cookie, bearer credential or plaintext campaign name is persisted.
// Same-origin scripts may decrypt: this is encryption at rest, NOT end-to-end.
export function createEncryptedCreateJournal({ databaseName, aadDomain, validateBody }) {
const DB = databaseName;
const VERSION = 1;
const PENDING = 'pending-creates';
const KEYS = 'scope-keys';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function checked(scope, body) {
  if (typeof scope !== 'string' || scope.length < 10 ||
      !body || typeof body !== 'object' || Array.isArray(body) ||
      !UUID.test(body.client_request_id || '') || !validateBody(body)) {
    throw new Error('El envío pendiente no tiene una identidad recuperable.');
  }
  return body;
}
function cryptoAvailable() {
  if (!globalThis.crypto?.subtle || !globalThis.crypto?.getRandomValues) {
    throw new Error('El cifrado local requiere HTTPS y un navegador compatible.');
  }
  return globalThis.crypto;
}
function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB no está disponible; no se puede asegurar el reintento.'));
      return;
    }
    const request = indexedDB.open(DB, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PENDING)) {
        db.createObjectStore(PENDING, { keyPath: 'scope' });
      }
      if (!db.objectStoreNames.contains(KEYS)) {
        db.createObjectStore(KEYS, { keyPath: 'scope' });
      }
    };
    request.onerror = () => reject(request.error || new Error('No se pudo abrir la recuperación de solicitudes.'));
    request.onblocked = () => reject(new Error('Cerrá otras pestañas para recuperar el envío.'));
    request.onsuccess = () => resolve(request.result);
  });
}
async function dbTransaction(stores, mode, run) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error('Falló el almacenamiento de el envío.'));
      tx.onabort = () => reject(tx.error || new Error('No se confirmó el almacenamiento de el envío.'));
      try { run(tx, next => { result = next; }); }
      catch (error) { tx.abort(); reject(error); }
    });
  } finally { db.close(); }
}
const getOne = (table, scope) => dbTransaction([table], 'readonly', (tx, done) => {
  const request = tx.objectStore(table).get(scope);
  request.onsuccess = () => done(request.result);
});

async function getKey(scope) {
  const existing = await getOne(KEYS, scope);
  if (existing?.key) return existing.key;
  // Never replace the key for an existing ciphertext; preserve evidence of
  // lost storage instead of converting an ambiguous ACK into a fresh POST.
  if (await getOne(PENDING, scope)) {
    throw new Error('Falta la clave cifrada de una solicitud pendiente. No se enviará otra.');
  }
  const key = await cryptoAvailable().subtle.generateKey(
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  try {
    await dbTransaction([KEYS], 'readwrite', tx => {
      tx.objectStore(KEYS).add({ scope, key });
    });
    return key;
  } catch (error) {
    // Concurrent tabs may win key creation. Never overwrite their key.
    const winner = await getOne(KEYS, scope);
    if (winner?.key) return winner.key;
    throw error;
  }
}
const additionalData = (scope, id) =>
  encoder.encode(aadDomain + scope + ':' + id);

async function read(scope) {
  if (!scope) return null;
  const record = await getOne(PENDING, scope);
  if (!record) return null;
  if (!UUID.test(record.id || '') || !Array.isArray(record.iv) ||
      record.iv.length !== 12 || !(record.ciphertext instanceof ArrayBuffer)) {
    throw new Error('La solicitud pendiente está dañada y no se descartará.');
  }
  const key = await getKey(scope);
  try {
    const plain = await cryptoAvailable().subtle.decrypt({
      name: 'AES-GCM',
      iv: new Uint8Array(record.iv),
      additionalData: additionalData(scope, record.id),
      tagLength: 128
    }, key, record.ciphertext);
    const body = JSON.parse(decoder.decode(plain));
    checked(scope, body);
    if (body.client_request_id !== record.id) throw new Error('Identidad alterada.');
    return Object.freeze({ scope, id: record.id, body: Object.freeze(body) });
  } catch {
    throw new Error('No se pudo descifrar el envío pendiente. No se borrarán sus datos.');
  }
}

async function save(scope, body) {
  checked(scope, body);
  if (await read(scope)) {
    throw new Error('Ya hay una solicitud pendiente de confirmar. Recuperala antes de crear otra.');
  }
  const key = await getKey(scope);
  const iv = cryptoAvailable().getRandomValues(new Uint8Array(12));
  const ciphertext = await cryptoAvailable().subtle.encrypt({
    name: 'AES-GCM', iv,
    additionalData: additionalData(scope, body.client_request_id),
    tagLength: 128
  }, key, encoder.encode(JSON.stringify(body)));
  // add (NOT put) is atomic across tabs, even for concurrent user actions.
  // A failed IDB commit must prevent dispatching any HTTP POST.
  try {
    await dbTransaction([PENDING], 'readwrite', tx => {
      tx.objectStore(PENDING).add({
        scope, id: body.client_request_id, iv: [...iv], ciphertext
      });
    });
  } catch {
    throw new Error('Otra pestaña puede tener una solicitud pendiente. Recuperala antes de enviar otra.');
  }
  return true;
}

async function discard(scope, requestId) {
  if (!scope || !UUID.test(requestId || '')) return false;
  // Compare and delete within ONE IndexedDB transaction; stale tabs cannot
  // erase a newer request that replaced the pending slot.
  return dbTransaction([PENDING], 'readwrite', (tx, done) => {
    const store = tx.objectStore(PENDING);
    const request = store.get(scope);
    request.onsuccess = () => {
      if (request.result?.id !== requestId) { done(false); return; }
      store.delete(scope);
      done(true);
    };
  });
}

return Object.freeze({ read, save, discard });
}
