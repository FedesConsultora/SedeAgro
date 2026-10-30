// Reusable real-Chromium IndexedDB assertions. Reads only vault metadata,
// never decrypts or logs sensitive request bodies, keys or ciphertext.
import assert from 'node:assert/strict';

export async function inspectEncryptedCreateJournal(page, databaseName) {
  return page.evaluate(name => new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      request.transaction.abort();
      reject(new Error('Expected an already-created offline journal'));
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('pending-creates', 'readonly');
      const pending = tx.objectStore('pending-creates').getAll();
      pending.onsuccess = () => {
        const rows = pending.result.map(row => ({
          id: row.id,
          ciphertext: row.ciphertext instanceof ArrayBuffer,
          ivLength: row.iv?.length,
          // Metadata is an opaque scope string and request UUID; plaintext
          // business fields must remain absent from serialized records.
          persistedMetadata: JSON.stringify({
            id: row.id, scope: row.scope, iv: row.iv
          }),
          ownProperties: Object.keys(row)
        }));
        resolve(rows);
      };
      pending.onerror = () => reject(pending.error);
      tx.oncomplete = () => db.close();
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  }), databaseName);
}

export async function assertSealedPendingCreate(page, databaseName, requestId, forbiddenText) {
  const rows = await inspectEncryptedCreateJournal(page, databaseName);
  assert.equal(rows.length, 1, 'one pending encrypted create per actor/module');
  assert.equal(rows[0].id, requestId, 'pending journal keeps original exact UUID');
  assert.equal(rows[0].ciphertext, true, 'journal contains encrypted ArrayBuffer');
  assert.equal(rows[0].ivLength, 12, 'AES-GCM uses a unique 96-bit IV');
  assert.deepEqual(rows[0].ownProperties.sort(),
    ['scope', 'id', 'iv', 'ciphertext'].sort());
  assert.ok(!rows[0].persistedMetadata.includes(forbiddenText),
    'plaintext business content cannot appear in IndexedDB metadata');
}

export async function assertNoPendingCreate(page, databaseName) {
  assert.equal((await inspectEncryptedCreateJournal(page, databaseName)).length, 0,
    'verified replay retires durable encrypted pending create');
}
