import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const provider = readFileSync(new URL('../src/context/SessionContext.jsx', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const tabSync = readFileSync(new URL('../src/services/sessionTabSync.js', import.meta.url), 'utf8');
const browser = readFileSync(new URL('../../scripts/acceptance-browser-evidence-history.mjs', import.meta.url), 'utf8');

test('only login and confirmed server logout publish the transition, not draft writes', () => {
  assert.match(provider, /const login = \(data\) =>/);
  assert.match(provider, /await api\.logout\(\);[\s\S]*tabSyncRef\.current\?\.publish\(\)/);
  assert.match(provider, /tabSyncRef\.current\?\.publish\(\)/);
  assert.doesNotMatch(tabSync, /offlineQueue|IndexedDB|indexedDB|token\s*:|tenantId\s*:|userId\s*:/);
});

test('external identity changes quarantine React before server verification', () => {
  assert.match(provider, /sessionRef\.current = demoSession;[\s\S]*authEpochRef\.current \+= 1;/);
  assert.match(provider, /const hint = localStorage\.getItem\('sedeagro\.tenantHint'\)/);
  assert.match(provider, /fetch\(`\$\{API_URL\}\/auth\/me`/);
  assert.match(provider, /sequence === validationSequenceRef\.current && epoch === authEpochRef\.current/);
  assert.match(provider, /createSessionTabSync\(\(\) => \{[\s\S]*?lockOfflineFieldVault\(\);[\s\S]*?void revalidate\(\{ quarantine: true \}\)/);
  assert.match(provider, /void clearOfflineFieldVault\(\)\.catch/);
  assert.match(provider, /shouldRecheckOnForeground/);
  assert.match(app, /if \(isAuthenticated\) setAuthView\('login'\)/);
  assert.match(app, /if \(sessionCheckError\)/);
  assert.match(app, /No se muestran\s+datos privados hasta recuperar una sesión autorizada/);
});

test('browser gate covers a real cross-tab logout, account switch and restore', () => {
  assert.match(browser, /PASS: multi-tab server logout removed previous tenant private view/);
  assert.match(browser, /PASS: cross-tenant browser login adopted new authenticated identity/);
  assert.match(browser, /PASS: returning to first account reads its own evidence anew/);
});

test('server-confirmed logout closes React and broadcasts despite a failed IndexedDB deletion', () => {
  const start = provider.indexOf('const logout = async () => {');
  const end = provider.indexOf('// Cookie-based authentication:', start);
  assert.ok(start > -1 && end > start);
  const logout = provider.slice(start, end);
  assert.match(logout, /await api\.logout\(\)/);
  assert.match(logout, /catch \(error\) \{[\s\S]*?return;/,
    'failed server logout must not falsely claim a completed logout');
  assert.match(logout, /const retirement = retireOfflineFieldVault\(\);[\s\S]*setSession\(null\);/);
  assert.match(logout, /setSession\(null\);[\s\S]*tabSyncRef\.current\?\.publish\(\);/);
  assert.match(logout, /if \(!\(await retirement\)\) \{[\s\S]*showError/);
  assert.doesNotMatch(logout, /await clearOfflineFieldVault\(\)/,
    'a storage failure must not be caught as an unsuccessful server logout');
});

test('only a current-session 401 retires local field access and closes the view', () => {
  const start = provider.indexOf('const expired = (event) => {');
  const end = provider.indexOf("window.addEventListener('sedeagro:session-expired'", start);
  assert.ok(start > -1 && end > start);
  const handler = provider.slice(start, end);
  assert.match(handler,
    /if \(!isCurrentSessionExpiry\(event\?\.detail, sessionRef\.current, authEpochRef\.current\)\) return;/);
  assert.match(handler, /return;[\s\S]*void retireOfflineFieldVault\(\)/);
  assert.match(handler, /void retireOfflineFieldVault\(\)[\s\S]*setSession\(null\)/);
  assert.match(handler, /if \(!cleared\) showError/);
});

test('a missed transition quarantines before bounded foreground polling, even without tenant hint', () => {
  const onForeground = provider.slice(
    provider.indexOf('const onForeground = () => {'),
    provider.indexOf('const onOnline = () => {'));
  assert.match(onForeground, /if \(document\.visibilityState !== 'visible'\) return;/);
  assert.match(onForeground, /if \(sync\.catchUp\(\)\) return;/);
  assert.ok(onForeground.indexOf('sync.catchUp()') <
    onForeground.indexOf('shouldRecheckOnForeground('),
    'missed identity must bypass the 60s throttle');
  assert.ok(onForeground.indexOf('sync.catchUp()') <
    onForeground.indexOf('if (!hint) return;'),
    'a missed logout must quarantine even when the shared tenant hint is missing');
  assert.match(onForeground, /hint !== sessionRef\.current\?\.tenant\?\.id/);
});

test('late old-tenant 401 or 200 cannot override a new cross-tab login', () => {
  const resolution = provider.slice(provider.indexOf('}).then((result) => {'),
    provider.indexOf('}).catch(() => {',provider.indexOf('}).then((result) => {')));
  assert.match(resolution, /tabSyncRef\.current\?\.catchUp\(\)/);
  assert.match(resolution, /if \(!isCurrent\(\)\) return;/);
  assert.match(resolution, /localStorage\.getItem\('sedeagro\.tenantHint'\)/);
  assert.match(resolution, /void revalidate\(\{ quarantine: true \}\);/);
  assert.ok(resolution.indexOf('catchUp()') <
    resolution.indexOf('result.unauthorized'),
    'fence the old response before logging out the replacement account');
  assert.ok(resolution.indexOf('sedeagro.tenantHint') <
    resolution.indexOf('setSession({ ...result.profile'),
    'fence the old response before authenticating an old profile');
});

test('witness is opaque; no account, draft or cookie can be written to browser storage', () => {
  assert.match(tabSync, /SESSION_TAB_WITNESS_KEY/);
  assert.match(tabSync, /browser\.localStorage\.setItem\(SESSION_TAB_WITNESS_KEY, JSON\.stringify\(signal\)\)/);
  assert.match(tabSync, /catchUp\(\) \{/);
  assert.doesNotMatch(tabSync, /localStorage\.setItem\([^\n]*tenant|localStorage\.setItem\([^\n]*token/);
});
