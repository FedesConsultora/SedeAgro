import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  OFFLINE_VAULT_MAX_AGE_MS, localFieldScope, sealFieldProfile,
  openFieldProfile, validateLocalFieldPassphrase, lockOfflineFieldVault,
  listOfflineFieldDrafts, queueOfflineFieldObservation
} from '../src/services/offlineFieldVault.js';

const tenant = 'a9000000-0000-4000-8000-000000000001';
const user = 'a9000000-0000-4000-8000-000000000002';
const member = 'a9000000-0000-4000-8000-000000000003';
const scope = tenant + ':' + user;
const session = Object.freeze({
  authenticated: true, tenant: { id: tenant },
  user: { id: user },
  membership: { id: member, roleCode: 'scout', status: 'active' },
  entitlements: ['scouting', 'gis']
});
const passphrase = 'my long field rescue passphrase #2026';
const code = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('local access can be provisioned only for a previously server-verified eligible scope', () => {
  assert.equal(localFieldScope(session), scope);
  for (const invalid of [
    { ...session, authenticated: false },
    { ...session, tenant: { id: 'other' } },
    { ...session, user: { id: 'other' } },
    { ...session, membership: { ...session.membership, id: '' } },
    { ...session, membership: { ...session.membership, status: 'blocked' } },
    { ...session, membership: { ...session.membership, roleCode: 'producer' } },
    { ...session, entitlements: ['org'] }
  ]) assert.equal(localFieldScope(invalid), null);
  assert.throws(() => validateLocalFieldPassphrase('1234'), /12 a 128/);
  assert.throws(() => validateLocalFieldPassphrase(' '.repeat(50)), /12 a 128/);
  assert.equal(validateLocalFieldPassphrase(passphrase), passphrase);
});

test('PBKDF2 AES-GCM envelope never persists tenant/user, password or notes in plaintext', async () => {
  const at = Date.parse('2026-10-29T12:00:00.000Z');
  const sealed = await sealFieldProfile(session, passphrase, at, webcrypto);
  assert.equal(sealed.version, 1);
  assert.equal(sealed.salt.length, 16);
  assert.equal(sealed.iv.length, 12);
  assert.ok(sealed.ciphertext instanceof ArrayBuffer);
  assert.doesNotMatch(JSON.stringify(sealed), /a9000000|field rescue|scout|password/i);
  const open = await openFieldProfile(sealed, passphrase, at + 1000, webcrypto);
  assert.equal(open.scope, scope);
  assert.equal(open.role, 'scout');
  assert.equal(open.membershipId, member);
  assert.equal(open.validUntil, at + OFFLINE_VAULT_MAX_AGE_MS);
  assert.equal(open.token, undefined);
  assert.equal(open.email, undefined);
  await assert.rejects(openFieldProfile(sealed, 'a very wrong secret for device', at + 1000, webcrypto),
    /incorrecta|vencido/);
  await assert.rejects(openFieldProfile(sealed, passphrase,
    at + OFFLINE_VAULT_MAX_AGE_MS, webcrypto), /incorrecta|vencido/);
  const tampered = structuredClone(sealed);
  tampered.iv[0] ^= 1;
  await assert.rejects(openFieldProfile(tampered, passphrase, at + 1000, webcrypto),
    /incorrecta|vencido/);
  const changed = await sealFieldProfile({ ...session, user: {id:member} }, passphrase, at, webcrypto);
  assert.notDeepEqual(changed.ciphertext, sealed.ciphertext);
});

test('offline queue capability rejects arbitrary objects, mismatched scope, and networkless API bypass', async () => {
  lockOfflineFieldVault();
  await assert.rejects(listOfflineFieldDrafts({scope}), /bloqueado/);
  await assert.rejects(queueOfflineFieldObservation({scope},
    'a9000000-0000-4000-8000-000000000004', {
      observation_type: 'general', severity: 'medium', notes: 'Do not leak'
    }), /bloqueado/);
  const source = code('../src/services/offlineFieldVault.js');
  const ui = code('../src/components/OfflineFieldWorkspace.jsx');
  const app = code('../src/App.jsx');
  const sessionContext = code('../src/context/SessionContext.jsx');
  assert.match(source, /const capabilities = new WeakMap\(\)/);
  assert.match(source, /!drafts\.some\(item => item\.runId === runId\)/);
  assert.match(source, /Date\.now\(\) >= state\.unlockedUntil/);
  assert.match(source, /Date\.now\(\) >= state\.validUntil/);
  assert.match(source, /store\.put\(sealed\)/);
  assert.match(source, /store\.delete\(RECORD\)/);
  assert.match(source, /await indexedDbQueueStore\.list\(state\.scope\)/);
  assert.doesNotMatch(source, /(?:localStorage|sessionStorage)\.(?:getItem|setItem|removeItem)|\bfetch\(|credentials: 'include'/);
  assert.doesNotMatch(ui, /\.flush\(|\.submitSyncBatch\(|\.submitOfflineEvidence\(/);
  assert.match(ui, /await expected\.api\.me\(\)/);
  assert.match(ui, /document\.visibilityState === 'hidden'/);
  assert.match(ui, /onClose\(\)/);
  assert.match(app, /sessionCheckError && !online && showOfflineField/);
  assert.match(sessionContext, /const retirement = retireOfflineFieldVault\(\)/);
  assert.match(sessionContext, /void retireOfflineFieldVault\(\)/);
  assert.match(sessionContext, /lockOfflineFieldVault\(\)/);
});

test('client never silently treats local unlock as authenticated HTTP session', () => {
  const source = code('../src/services/offlineFieldVault.js');
  const app = code('../src/App.jsx');
  const sync = code('../src/pages/SyncPage.jsx');
  assert.match(source, /The local-only identity is NEVER|This local-only identity is NEVER/);
  assert.match(source, /queueObservation\(localIdentity, runId, values\)/);
  assert.doesNotMatch(source, /setSession\(|createApiClient\(|signSession\(/);
  assert.match(sync, /OfflineFieldSetup api=\{api\} session=\{session\}/);
  assert.match(app, /Desbloquear borradores de campo sin conexión/);
});

test('local envelope operations fence async IndexedDB mutations against identity changes', () => {
  const source = code('../src/services/offlineFieldVault.js');
  assert.match(source, /function assertCurrentVaultGeneration\(expected\)/);
  assert.match(source, /const expected = lockOfflineFieldVault\(\);[\s\S]*await sealFieldProfile/);
  assert.match(source, /await transaction\('readwrite', store => \{[\s\S]*assertCurrentVaultGeneration\(expected\);[\s\S]*store\.put\(sealed\)/);
  assert.match(source, /const expected = generation;[\s\S]*await transaction\('readonly', store => store\.get\(RECORD\)\);[\s\S]*assertCurrentVaultGeneration\(expected\)/);
  assert.match(source, /if \(generation !== expected \|\| readSharedVaultEpoch\(\) !== sharedEpoch\) return null;[\s\S]*store\.delete\(RECORD\)/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|\bfetch\(/);
});
