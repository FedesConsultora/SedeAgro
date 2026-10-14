import test from 'node:test';
import assert from 'node:assert/strict';
import { bearerToken, isPlatformAdministrator } from '../src/infra/security/securityGuards.js';
import { demoSeedEnabled, assertDemoSeedConfig } from '../src/infra/db/seedPolicy.js';

test('authorization header accepts a single bearer token, rejects missing and malformed headers', () => {
  assert.equal(bearerToken('Bearer abc.def.ghi'), 'abc.def.ghi');
  assert.equal(bearerToken('bearer\tvalid_token'), 'valid_token');
  for (const header of [undefined, '', 'Basic secret', 'Bearer', 'Bearer  ', 'Bearer token extra', 'Bearer a\nb']) {
    assert.equal(bearerToken(header), null, `header ${JSON.stringify(header)} should be rejected`);
  }
});

test('platform administration requires an authenticated user with explicit platform flag', () => {
  assert.equal(isPlatformAdministrator(undefined), false);
  assert.equal(isPlatformAdministrator({}), false);
  assert.equal(isPlatformAdministrator({ user: {} }), false);
  assert.equal(isPlatformAdministrator({ user: { is_platform_admin: false } }), false);
  assert.equal(isPlatformAdministrator({ user: { is_platform_admin: 'true' } }), false);
  assert.equal(isPlatformAdministrator({ user: { is_platform_admin: true } }), true);
});

test('demo seed is disabled in production, including with SEED_MODE=demo', () => {
  assert.equal(demoSeedEnabled({ NODE_ENV: 'production', SEED_MODE: 'demo' }), false);
  assert.equal(demoSeedEnabled({ NODE_ENV: 'production', SEED_MODE: 'dev' }), false);
  assert.equal(demoSeedEnabled({ NODE_ENV: 'development', SEED_MODE: 'dev' }), false);
  assert.equal(demoSeedEnabled({ NODE_ENV: 'test', SEED_MODE: 'demo' }), true);
});

test('demo seeding requires deliberate opt-in and a nontrivial password', () => {
  assert.throws(() => assertDemoSeedConfig({ NODE_ENV: 'production', SEED_MODE: 'demo', DEMO_PASSWORD: 'long-development-password' }));
  assert.throws(() => assertDemoSeedConfig({ NODE_ENV: 'development', SEED_MODE: 'dev', DEMO_PASSWORD: 'long-development-password' }));
  assert.throws(() => assertDemoSeedConfig({ NODE_ENV: 'development', SEED_MODE: 'demo', DEMO_PASSWORD: 'short' }));
  assert.equal(assertDemoSeedConfig({ NODE_ENV: 'development', SEED_MODE: 'demo', DEMO_PASSWORD: 'long-development-password' }), 'long-development-password');
});
