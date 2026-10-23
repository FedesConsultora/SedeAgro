import {
  generateLocalKey, isSealedRecord, openOfflineDraft, sealOfflineDraft
} from './offlineDraftCrypto.js';
import { MAX_PENDING_BATCHES } from './offlineSyncModel.js';

const DB_NAME = 'sedeagro-offline-sync';
const DB_VERSION = 2;
const STORE = 'pending-observations';
const KEY_STORE = 'draft-keys';
const blockedMessage = 'Cerrá otras pestañas de SedeAgro y volvé a intentar.';
// The AES-GCM IV is a fresh opaque revision of the encrypted record. It is
// not a counter, encryption key, business ID or evidence of server delivery.
// WeakMap ensures only THIS store's verified decrypt can authorize a mutation.
const observedVersions = new WeakMap();

function sealedRevision(raw) {
  return isSealedRecord(raw) && Array.isArray(raw.sealed.iv) &&
    raw.sealed.iv.length === 12 ? raw.sealed.iv.join(',') : null;
}

function checkedExpected(expected, id) {
  const revision = expected && typeof expected === 'object'
    ? observedVersions.get(expected) : null;
  if (!revision || expected.id !== id ||
      expected.scope !== id.slice(0, id.lastIndexOf(':'))) {
    throw new Error('La revisión local no es verificable. Volvé a abrir la cola.');
  }
  return revision;
}

// Read+compare+write happens atomically in ONE IndexedDB transaction.
// Encrypt the replacement BEFORE the transaction: WebCrypto is asynchronous.
async function compareAndWrite(id, revision, update) {
  return transact([STORE], 'readwrite', (tx, setValue) => {
    const store = tx.objectStore(STORE);
    const request = store.get(id);
    request.onsuccess = () => {
      if (sealedRevision(request.result) !== revision) {
        setValue(false);
        return;
      }
      update(store);
      setValue(true);
    };
  });
}

function openQueueDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('Este navegador no permite almacenamiento offline (IndexedDB).'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('scope', 'scope', { unique: false });
      }
      if (!db.objectStoreNames.contains(KEY_STORE)) {
        db.createObjectStore(KEY_STORE, { keyPath: 'scope' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('No se pudo abrir la cola offline.'));
    req.onblocked = () => reject(new Error(blockedMessage));
  });
}

// All operations resolve only after IndexedDB commits. A crash after the
// transaction starts cannot yield a misleading success acknowledgment.
async function transact(stores, mode, submit) {
  const db = await openQueueDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let value;
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error || new Error('Falló el almacenamiento local.'));
      tx.onabort = () => reject(tx.error || new Error('Se canceló el guardado local.'));
      try {
        submit(tx, (next) => { value = next; });
      } catch (error) {
        tx.abort();
        reject(error);
      }
    });
  } finally {
    db.close();
  }
}

function requestValue(store, action) {
  return transact([store], 'readonly', (tx, setValue) => {
    const req = action(tx.objectStore(store));
    req.onsuccess = () => setValue(req.result);
  });
}

async function readRaw(id) {
  return requestValue(STORE, (store) => store.get(id));
}

async function readScope(scope) {
  return requestValue(STORE, (store) =>
    store.index('scope').getAll(IDBKeyRange.only(scope)));
}

async function getScopeKey(scope) {
  const saved = await requestValue(KEY_STORE, (store) => store.get(scope));
  if (saved?.key) return saved.key;

  // If the browser erased the key store but kept encrypted records, fail
  // closed rather than silently replacing a key and losing existing drafts.
  const rows = await readScope(scope);
  if (rows.some(isSealedRecord)) {
    throw new Error('Se perdió la clave local de cifrado. Los borradores no se eliminarán automáticamente.');
  }

  const key = await generateLocalKey();
  try {
    await transact([KEY_STORE], 'readwrite', (tx) => {
      tx.objectStore(KEY_STORE).add({ scope, key });
    });
    return key;
  } catch (error) {
    // Concurrent tabs can race to create a key. Never overwrite the winner.
    const winner = await requestValue(KEY_STORE, (store) => store.get(scope));
    if (winner?.key) return winner.key;
    throw error;
  }
}

async function migrateLegacy(row) {
  const key = await getScopeKey(row.scope);
  const sealed = await sealOfflineDraft(row, key);
  // Compare-and-swap: an old open tab may have updated/deleted the row while
  // encryption was running. Do not recreate discarded rows or overwrite edits.
  return transact([STORE], 'readwrite', (tx, setValue) => {
    const store = tx.objectStore(STORE);
    const req = store.get(row.id);
    req.onsuccess = () => {
      const current = req.result;
      if (!current) { setValue(null); return; }
      if (!isSealedRecord(current) && JSON.stringify(current) === JSON.stringify(row)) {
        store.put(sealed);
        setValue(sealed);
      } else {
        setValue(current);
      }
    };
  });
}

async function decryptRow(row, depth = 0) {
  if (!row) return undefined;
  if (depth > 2) throw new Error('El borrador fue modificado por otra pestaña. Volvé a intentar.');
  if (!isSealedRecord(row)) {
    // Every pre-0J plaintext draft is migrated before use. If migration fails,
    // report an error; NEVER delete, skip, or silently send the legacy record.
    const next = await migrateLegacy(row);
    if (!next) return undefined;
    return decryptRow(next, depth + 1);
  }
  const key = await getScopeKey(row.scope);
  const item = await openOfflineDraft(row, key);
  const revision = sealedRevision(row);
  if (!revision) throw new Error('El cifrado del borrador no tiene una revisión verificable.');
  observedVersions.set(item, revision);
  return item;
}

function describeWriteFailure(error) {
  if (error?.name === 'QuotaExceededError' ||
      error?.name === 'UnknownError' && /quota/i.test(error.message)) {
    throw new Error('No queda espacio local para guardar la observación. Liberá espacio sin borrar borradores pendientes.');
  }
  throw error;
}

export const indexedDbQueueStore = Object.freeze({
  async get(id) {
    return decryptRow(await readRaw(id));
  },
  async put(item, { expected = null } = {}) {
    try {
      const key = await getScopeKey(item.scope);
      const revision = expected ? checkedExpected(expected, item.id) : null;
      const encrypted = await sealOfflineDraft(item, key);
      if (!expected) {
        // Enforce the per-actor limit in the SAME write transaction as add.
        // The queue's earlier list() is only a UI preflight: two tabs could
        // both see 99 rows. IDB serializes readwrite transactions on STORE,
        // so only one of their inserts can commit at the 100-row boundary.
        const inserted = await transact([STORE], 'readwrite', (tx, setValue) => {
          const rows = tx.objectStore(STORE);
          const count = rows.index('scope').count(IDBKeyRange.only(item.scope));
          count.onsuccess = () => {
            if (count.result >= MAX_PENDING_BATCHES) {
              setValue(false); // No mutation, commit cleanly, report refusal.
              return;
            }
            rows.add(encrypted); // Fails atomically on duplicate UUID.
            setValue(true);
          };
        });
        if (!inserted) {
          throw new Error(`La cola local llegó al límite de ${MAX_PENDING_BATCHES} observaciones.`);
        }
        return item.id;
      }
      const saved = await compareAndWrite(item.id, revision, store => store.put(encrypted));
      if (saved) {
        // Return the exact revision created by THIS successful commit, rather
        // than relying on a later get() which might read another tab's re-seal.
        observedVersions.set(item, sealedRevision(encrypted));
      }
      return saved;
    } catch (error) {
      describeWriteFailure(error);
    }
  },
  async delete(id, { expected } = {}) {
    const revision = checkedExpected(expected, id);
    return compareAndWrite(id, revision, store => store.delete(id));
  },
  async list(scope) {
    if (!scope) return [];
    const rows = await readScope(scope);
    const items = await Promise.all(rows.map((row) => decryptRow(row)));
    return items.filter(Boolean).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
});
