import test from 'node:test';
import assert from 'node:assert/strict';
import { retireOfflineFieldVault } from '../src/services/offlineVaultRetirement.js';

test('local capability locks before deleting the saved encrypted envelope', async () => {
  const events = [];
  assert.equal(await retireOfflineFieldVault({
    lock: () => events.push('lock'),
    clear: async () => { events.push('clear'); }
  }), true);
  assert.deepEqual(events, ['lock', 'clear']);
});

test('storage failure never undoes a confirmed server logout', async () => {
  const events = [];
  assert.equal(await retireOfflineFieldVault({
    lock: () => events.push('lock'),
    clear: async () => {
      events.push('clear');
      throw new Error('IndexedDB blocked');
    }
  }), false);
  assert.deepEqual(events, ['lock', 'clear']);
});

test('local lock happens even when deletion is still pending', async () => {
  let resolveDelete;
  const pendingDelete = new Promise(resolve => { resolveDelete = resolve; });
  const events = [];
  const retirement = retireOfflineFieldVault({
    lock: () => events.push('lock'),
    clear: () => { events.push('delete requested'); return pendingDelete; }
  });
  assert.deepEqual(events, ['lock', 'delete requested']);
  resolveDelete();
  assert.equal(await retirement, true);
});
