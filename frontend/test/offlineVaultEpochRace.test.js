import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
  clearOfflineFieldVault, enrollOfflineFieldVault, lockOfflineFieldVault,
  openFieldProfile, unlockOfflineFieldVault
} from '../src/services/offlineFieldVault.js';

const tenant = 'b9000000-0000-4000-8000-000000000001';
const firstActor = 'b9000000-0000-4000-8000-000000000002';
const nextActor = 'b9000000-0000-4000-8000-000000000003';
const membership = 'b9000000-0000-4000-8000-000000000004';
const phrase = 'A secure local offline phrase 2026';
const profile = (id) => ({
  authenticated: true,
  tenant: { id: tenant },
  user: { id },
  membership: { id: membership, roleCode: 'scout', status: 'active' },
  entitlements: ['scouting']
});

// A deterministic IndexedDB transaction stub: the *open* request can be held
// while another account replaces the active envelope. Every operation still
// completes in an IDB-style transaction callback, with no network or mock HTTP.
function createDeferredVaultDb() {
  let saved = null;
  let holdNext = null;
  const database = {
    close() {},
    transaction() {
      const tx = {
        objectStore() {
          const request = (perform) => {
            const req = {};
            queueMicrotask(() => {
              try {
                req.result = perform();
                req.onsuccess?.();
                queueMicrotask(() => tx.oncomplete?.());
              } catch (error) {
                tx.error = error;
                tx.onerror?.();
              }
            });
            return req;
          };
          return {
            get(key) { return request(() => key === 'active' ? saved : undefined); },
            put(row) { return request(() => { saved = row; return row.id; }); },
            delete(key) { return request(() => { if (key === 'active') saved = null; }) }
          };
        },
        abort() { tx.onabort?.(); }
      };
      return tx;
    }
  };
  return {
    indexedDB: {
      open() {
        const req = { result: database };
        const hold = holdNext;
        holdNext = null;
        if (hold) {
          hold.started();
          void hold.pending.then(() => queueMicrotask(() => req.onsuccess?.()));
        } else queueMicrotask(() => req.onsuccess?.());
        return req;
      }
    },
    holdOpen() {
      let notify, release;
      const started = new Promise(resolve => { notify = resolve; });
      const pending = new Promise(resolve => { release = resolve; });
      holdNext = { pending, started: notify };
      return { started, release };
    },
    get row() { return saved; }
  };
}

function mountVault(t) {
  const idb = createDeferredVaultDb();
  const originalIdb = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: idb.indexedDB });
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  t.after(() => {
    if (originalIdb) Object.defineProperty(globalThis, 'indexedDB', originalIdb);
    else Reflect.deleteProperty(globalThis, 'indexedDB');
    if (originalCrypto) Object.defineProperty(globalThis, 'crypto', originalCrypto);
    else Reflect.deleteProperty(globalThis, 'crypto');
    lockOfflineFieldVault();
  });
  return idb;
}

async function expectSettled(promise, step) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('IndexedDB test harness stalled at ' + step)), 3000);
    })]);
  } finally { clearTimeout(timer); }
}

test('slow old-session IDB delete cannot erase a newly enrolled account envelope', async t => {
  const db = mountVault(t);
  await expectSettled(enrollOfflineFieldVault(profile(firstActor), phrase), 'enroll first');
  assert.ok(db.row);

  const deferred = db.holdOpen();
  const oldRetirement = clearOfflineFieldVault();
  await expectSettled(deferred.started, 'held open start');
  await expectSettled(enrollOfflineFieldVault(profile(nextActor), phrase), 'enroll replacement');
  const newerEnvelope = db.row;
  assert.ok(newerEnvelope);
  deferred.release();
  await expectSettled(oldRetirement, 'retire stale');

  assert.equal(db.row, newerEnvelope,
    'late clear must not remove the new actor envelope');
  const opened = await openFieldProfile(db.row, phrase);
  assert.equal(opened.userId, nextActor);

  // A genuine current-session logout still removes the active envelope.
  await clearOfflineFieldVault();
  assert.equal(db.row, null);
});

test('a delayed PBKDF2 enrollment cannot commit after a newer session locks the device', async t => {
  const db = mountVault(t);
  const deferred = db.holdOpen();
  const obsolete = enrollOfflineFieldVault(profile(firstActor), phrase);
  await expectSettled(deferred.started, 'held open start');
  lockOfflineFieldVault();
  deferred.release();
  await assert.rejects(obsolete, /acceso local cambió/);
  assert.equal(db.row, null, 'old account must not recreate an envelope after logout');
});

test('offline unlock opened before a lock cannot grant capability after identity changes', async t => {
  const db = mountVault(t);
  await expectSettled(enrollOfflineFieldVault(profile(firstActor), phrase), 'enroll first');
  const deferred = db.holdOpen();
  const unlock = unlockOfflineFieldVault(phrase);
  await expectSettled(deferred.started, 'held open start');
  lockOfflineFieldVault();
  deferred.release();
  await assert.rejects(unlock, /acceso local cambió/);
  assert.ok(db.row, 'locking never destroys encrypted drafts or the envelope by itself');
});
