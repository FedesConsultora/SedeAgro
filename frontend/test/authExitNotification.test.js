import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const session = readFileSync(new URL('../src/context/SessionContext.jsx', import.meta.url), 'utf8');
const browser = readFileSync(new URL('../../scripts/acceptance-browser-cookie.mjs', import.meta.url), 'utf8');

test('public login/register/invite mount feedback after the private Shell unmounts', () => {
  const publicBranch = app.slice(app.indexOf('if (!isAuthenticated) {'));
  assert.match(publicBranch, /<NotificationToast \/>/);
  assert.match(publicBranch, /<GlobalLoader \/>/);
  assert.match(publicBranch, /\{publicPage\}/);
  assert.match(publicBranch, /authView === 'invite'/);
  assert.match(publicBranch, /<LoginPage /);
  assert.match(publicBranch, /<RegisterPage /);
  const shell = app.slice(app.indexOf('function Shell()'), app.indexOf('export function App()'));
  assert.equal(shell.match(/<NotificationToast \/>/g)?.length, 1);
  assert.equal(publicBranch.match(/<NotificationToast \/>/g)?.length, 1);
});

test('server ACK logout removes private views before waiting for vault deletion', () => {
  const start = session.indexOf('const logout = async () => {');
  const end = session.indexOf('// Cookie-based authentication:', start);
  const logout = session.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(logout, /await api\.logout\(\)/);
  assert.match(logout, /const retirement = retireOfflineFieldVault\(\)/);
  assert.ok(logout.indexOf('setSession(null)') < logout.indexOf('await retirement'));
  assert.ok(logout.indexOf('tabSyncRef.current?.publish()') < logout.indexOf('await retirement'));
  assert.match(logout, /if \(!\(await retirement\)\)[\s\S]*showError/);
});

test('real browser gate demands visible IDB failure warning and revoked cookie 401', () => {
  assert.match(browser, /window\.__vaultDeleteBlocked = true/);
  assert.match(browser, /logoutResponse\.status\(\), 204/);
  assert.match(browser, /Se cerró la sesión del servidor, pero no se pudo borrar el acceso offline local/);
  assert.match(browser, /assert\.equal\(await hasOfflineFieldEnvelope\(page1\), true/);
  assert.match(browser, /assert\.equal\(anonymous, 401/);
  assert.match(browser, /assert\.equal\(await hasOfflineFieldEnvelope\(page2\), false/);
});
