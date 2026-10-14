const DB_NAME = 'sedeagro-offline-sync';
const DB_VERSION = 1;
const STORE = 'pending-observations';

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
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('No se pudo abrir la cola local.'));
    req.onblocked = () => reject(new Error('Cerrá otras pestañas de SedeAgro y volvé a intentar.'));
  });
}

async function runTransaction(mode, run) {
  const db = await openQueueDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error('Falló el almacenamiento de observaciones.'));
      tx.onabort = () => reject(tx.error || new Error('Se canceló el almacenamiento de observaciones.'));
      try {
        const request = run(tx.objectStore(STORE));
        if (request) request.onsuccess = () => { result = request.result; };
      } catch (error) {
        tx.abort();
        reject(error);
      }
    });
  } finally {
    db.close();
  }
}

export const indexedDbQueueStore = Object.freeze({
  get: (id) => runTransaction('readonly', (store) => store.get(id)),
  put: (item) => runTransaction('readwrite', (store) => store.put(item)),
  delete: (id) => runTransaction('readwrite', (store) => store.delete(id)),
  list: async (scope) => {
    if (!scope) return [];
    const rows = await runTransaction('readonly',
      (store) => store.index('scope').getAll(IDBKeyRange.only(scope)));
    return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
});
