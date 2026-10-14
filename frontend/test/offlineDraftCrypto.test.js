import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
  generateLocalKey, isSealedRecord, openOfflineDraft, sealOfflineDraft
} from '../src/services/offlineDraftCrypto.js';
import {
  assertStorageCapacity, browserStorageStatus, requestDurableStorage
} from '../src/services/offlineStorageStatus.js';

const scope = '22222222-2222-4222-8222-222222222222:33333333-3333-4333-8333-333333333333';
const batchId = '44444444-4444-4444-8444-444444444444';
const item = {
  id: `${scope}:${batchId}`,
  scope,
  runId: '55555555-5555-4555-8555-555555555555',
  idempotencyKey: batchId,
  createdAt: '2026-10-14T00:00:00.000Z',
  state: 'pending',
  body: {
    client_id: 'sedeagro-web-offline-v1',
    idempotency_key: batchId,
    operations: [{
      entity_client_id: '66666666-6666-4666-8666-666666666666',
      operation: 'create',
      entity_type: 'scouting_observation',
      payload: {
        scouting_run_id: '55555555-5555-4555-8555-555555555555',
        notes: 'Private crop observation with sensitive text'
      }
    }]
  }
};

test('AES-256-GCM non-extractable key round-trips browser draft without storing plaintext', async () => {
  const key = await generateLocalKey(webcrypto);
  assert.equal(key.extractable, false);
  assert.equal(key.algorithm.name, 'AES-GCM');
  assert.equal(key.algorithm.length, 256);
  await assert.rejects(webcrypto.subtle.exportKey('raw', key));

  const sealed = await sealOfflineDraft(item, key, webcrypto);
  assert.ok(isSealedRecord(sealed));
  assert.deepEqual(Object.keys(sealed).sort(), ['createdAt', 'id', 'scope', 'sealed']);
  assert.equal(sealed.sealed.iv.length, 12);
  assert.equal(sealed.sealed.ciphertext instanceof ArrayBuffer, true);
  assert.ok(!JSON.stringify(sealed).includes('Private crop observation'));
  assert.deepEqual(await openOfflineDraft(sealed, key, webcrypto), item);
});

test('AES-GCM uses random IV and authenticates account scope, ID and ciphertext', async () => {
  const key = await generateLocalKey(webcrypto);
  const a = await sealOfflineDraft(item, key, webcrypto);
  const b = await sealOfflineDraft(item, key, webcrypto);
  assert.notDeepEqual(a.sealed.iv, b.sealed.iv);
  const otherKey = await generateLocalKey(webcrypto);
  await assert.rejects(openOfflineDraft(a, otherKey, webcrypto), /No se pudo descifrar/);
  await assert.rejects(openOfflineDraft({ ...a, scope: 'other-user' }, key, webcrypto), /No se pudo descifrar/);
  await assert.rejects(openOfflineDraft({ ...a, id: a.id + '-tampered' }, key, webcrypto), /No se pudo descifrar/);
  const tampered = new Uint8Array(a.sealed.ciphertext.slice(0));
  tampered[tampered.length - 1] ^= 0xff;
  await assert.rejects(openOfflineDraft({
    ...a, sealed: { ...a.sealed, ciphertext: tampered.buffer }
  }, key, webcrypto), /No se pudo descifrar/);
});

test('identity mismatches inside otherwise authenticated ciphertext are still rejected', async () => {
  const key = await generateLocalKey(webcrypto);
  const altered = { ...item, idempotencyKey: 'another-key' };
  const sealed = await sealOfflineDraft(altered, key, webcrypto);
  await assert.rejects(openOfflineDraft(sealed, key, webcrypto), /No se pudo descifrar/);
});

test('encryption rejects missing browser crypto and unscoped records before storage', async () => {
  await assert.rejects(generateLocalKey(null), /cifrar/i);
  const key = await generateLocalKey(webcrypto);
  await assert.rejects(sealOfflineDraft({ ...item, id: 'not-scoped' }, key, webcrypto),
    /identidad/i);
  await assert.rejects(sealOfflineDraft(item, key, null), /cifrado/i);
});

test('storage diagnostics are transparent and persistence is only requested explicitly', async () => {
  const storage = {
    estimate: async () => ({ quota: 20 * 1048576, usage: 8 * 1048576 }),
    persisted: async () => false,
    persist: async () => true
  };
  const status = await browserStorageStatus({ storage });
  assert.deepEqual(status, {
    supported: true, quota: 20 * 1048576, usage: 8 * 1048576,
    persisted: false
  });
  assert.equal(await requestDurableStorage({ storage }), true);
  assert.deepEqual(await browserStorageStatus(null), {
    supported: false, quota: null, usage: null, persisted: null
  });
  await assert.rejects(requestDurableStorage(null), /no admite/i);
});

test('storage capacity guard leaves enough headroom without claiming guaranteed quota', () => {
  assert.doesNotThrow(() => assertStorageCapacity({ quota: null, usage: null }));
  assert.doesNotThrow(() => assertStorageCapacity({ quota: 1000000, usage: 100000 }));
  assert.throws(() => assertStorageCapacity({ quota: 1000000, usage: 995000 }),
    /poco espacio/i);
});
