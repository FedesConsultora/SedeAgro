import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_COOKIE, clearSessionCookie, cookieToken, resolveAuthToken,
  requireCookieMutationHeader, sessionCookie, wantsCookieSession
} from '../src/infra/security/sessionTransport.js';

const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhYmNkIn0.validSignatureHere';

test('browser cookies are HttpOnly, SameSite Strict, root-path restricted and Secure in production', () => {
  const prod = sessionCookie(jwt, { prod: true });
  assert.ok(prod.includes('HttpOnly'));
  assert.ok(prod.includes('SameSite=Strict'));
  assert.ok(prod.includes('Secure'));
  assert.ok(prod.includes('Path=/api'));
  assert.ok(!sessionCookie(jwt, { prod: false }).includes('; Secure'));
  const erased = clearSessionCookie({ prod: true });
  assert.ok(erased.includes('Max-Age=0'));
  assert.ok(erased.includes('Secure'));
});

test('cookie extraction refuses duplicates and malformed credentials', () => {
  assert.equal(cookieToken(`other=1; ${SESSION_COOKIE}=${jwt}; tracking=off`), jwt);
  for (const header of ['', undefined, `${SESSION_COOKIE}=bad spaces`,
    `${SESSION_COOKIE}=${jwt}; ${SESSION_COOKIE}=${jwt}`, 'unrelated=x']) {
    assert.equal(cookieToken(header), null);
  }
});

test('bearer header takes precedence over cookie to avoid credential confusion', () => {
  assert.deepEqual(resolveAuthToken({ headers: { cookie: `${SESSION_COOKIE}=${jwt}`,
    authorization: 'Bearer explicit.token.signature' } }),
  { token: 'explicit.token.signature', transport: 'bearer' });
  assert.deepEqual(resolveAuthToken({ headers: {
    cookie: `${SESSION_COOKIE}=${jwt}`, authorization: 'Basic invalid'
  } }), { token: null, transport: 'bearer' });
  assert.deepEqual(resolveAuthToken({ headers: { cookie: `${SESSION_COOKIE}=${jwt}` } }),
    { token: jwt, transport: 'cookie' });
  assert.equal(wantsCookieSession({ headers: { 'x-sedeagro-session': 'cookie' } }), true);
  assert.equal(wantsCookieSession({ headers: {} }), false);
});

test('cookie-authenticated mutations require an unforgeable custom request header', () => {
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
    assert.throws(() => requireCookieMutationHeader({
      method, authTransport: 'cookie', headers: {}
    }), /protección/i);
    assert.doesNotThrow(() => requireCookieMutationHeader({
      method, authTransport: 'cookie', headers: { 'x-sedeagro-request': '1' }
    }));
  }
  assert.doesNotThrow(() => requireCookieMutationHeader({
    method: 'GET', authTransport: 'cookie', headers: {}
  }));
  assert.doesNotThrow(() => requireCookieMutationHeader({
    method: 'DELETE', authTransport: 'bearer', headers: {}
  }));
});
