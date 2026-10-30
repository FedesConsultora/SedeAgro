import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  VAULT_MUTATION_EPOCH_KEY, claimSharedVaultEpoch,
  readSharedVaultEpoch, assertSharedVaultEpoch
} from '../src/services/offlineVaultCrossTabEpoch.js';

function storage() {
  const map = new Map();
  return {
    getItem: key => map.has(key) ? map.get(key) : null,
    setItem: (key, value) => map.set(key, String(value)),
    read: () => Object.fromEntries(map)
  };
}

test('two separate browser-like realms share only a random mutation epoch', () => {
  const shared = storage();
  const crypto = { randomUUID };
  const tabA = claimSharedVaultEpoch(shared, crypto);
  assert.equal(readSharedVaultEpoch(shared), tabA);
  assertSharedVaultEpoch(tabA, shared);
  const tabB = claimSharedVaultEpoch(shared, crypto);
  assert.notEqual(tabA, tabB);
  assertSharedVaultEpoch(tabB, shared);
  assert.throws(() => assertSharedVaultEpoch(tabA, shared), /otra pestaña/);
  assert.deepEqual(Object.keys(shared.read()), [VAULT_MUTATION_EPOCH_KEY]);
  assert.equal(shared.read()[VAULT_MUTATION_EPOCH_KEY], tabB);
  assert.doesNotMatch(JSON.stringify(shared.read()),
    /tenant|user|password|token|session|draft|ciphertext|observation/i);
});

test('storage denial and corrupted marker fail closed, without persisting an identity', () => {
  const rejected = {
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => { throw new Error('SecurityError'); }
  };
  assert.throws(() => readSharedVaultEpoch(rejected), /coordinar/);
  assert.throws(() => claimSharedVaultEpoch(rejected, { randomUUID }), /coordinar/);
  const broken = storage();
  broken.setItem(VAULT_MUTATION_EPOCH_KEY, 'an-authority-token');
  assert.throws(() => readSharedVaultEpoch(broken), /coordinar/);
  assert.throws(() => assertSharedVaultEpoch('an-authority-token', broken), /coordinar/);
  assert.throws(() => claimSharedVaultEpoch(storage(), { randomUUID: () => 'invalid' }), /coordinar/);
});

test('vault guards cross-tab epoch at each async boundary and preserves HTTP isolation', () => {
  const source = readFileSync(new URL('../src/services/offlineFieldVault.js', import.meta.url), 'utf8');
  assert.match(source, /const sharedEpoch = claimSharedVaultEpoch\(\);/);
  assert.match(source, /assertSharedVaultEpoch\(sharedEpoch\);[\s\S]*return store\.put\(sealed\)/);
  assert.match(source, /readSharedVaultEpoch\(\) !== sharedEpoch\) return null/);
  assert.match(source, /readSharedVaultEpoch\(\) !== state\.sharedEpoch/);
  assert.match(source, /const sharedEpoch = readSharedVaultEpoch\(\);[\s\S]*const record = await transaction/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|\bfetch\(/);
});
