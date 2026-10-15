import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const api = readFileSync(new URL('../src/services/api.js', import.meta.url),'utf8');
const provider = readFileSync(new URL('../src/context/SessionContext.jsx', import.meta.url),'utf8');
const browser = readFileSync(new URL('../../scripts/acceptance-browser-evidence-history.mjs', import.meta.url),'utf8');

test('every API 401 event carries initiating session and epoch, not an unscoped global logout', () => {
  assert.match(api, /createApiClient\(session, feedback, authEpoch = 0\)/);
  assert.match(api, /new CustomEvent\('sedeagro:session-expired'/);
  assert.match(api, /detail: \{ scope: sessionScope\(session\), epoch: authEpoch \}/);
  assert.doesNotMatch(api, /new Event\('sedeagro:session-expired'\)/);
  assert.doesNotMatch(api, /authorization: .*authEpoch|token: authEpoch/);
});

test('provider synchronizes generation before delivering new session to React', () => {
  assert.match(provider, /const authEpochRef = useRef\(0\)/);
  assert.match(provider, /sessionRef\.current = normalized;\s*authEpochRef\.current \+= 1;/);
  assert.match(provider, /setAuthEpoch\(authEpochRef\.current\)/);
  assert.match(provider, /createApiClient\(session, feedbackActions, authEpoch\)/);
  assert.match(provider, /isCurrentSessionExpiry\(event\?\.detail, sessionRef\.current, authEpochRef\.current\)/);
  assert.match(provider, /startingEpoch !== authEpochRef\.current/);
});

test('browser coverage delays actual HTTP and checks stale 401 plus current revoked cookie', () => {
  assert.match(browser, /const realResponse = await route\.fetch\(\)/);
  assert.match(browser, /await delayedPageGate/);
  assert.match(browser, /await route\.fulfill\(\{ response: realResponse \}\)/);
  assert.match(browser, /late HTTP must not re-mount private evidence/);
  assert.match(browser, /epoch: 0/);
  assert.match(browser, /revoked_at=now\(\)/);
  assert.match(browser, /getByRole\('heading',\{name:'Iniciar sesión'\}\)/);
});
