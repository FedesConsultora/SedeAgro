import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const auth = readFileSync(new URL('../src/modules/auth/router.js', import.meta.url), 'utf8');
const platform = readFileSync(new URL('../src/modules/platform/router.js', import.meta.url), 'utf8');

test('public registration only accepts the starter plan and never binds arbitrary client planCode', () => {
  assert.match(auth, /planCode:\s*z\.literal\('starter'\)\.optional\(\)/);
  const register = auth.slice(auth.indexOf("authPublicRouter.post('/register-tenant'"),
    auth.indexOf("authPublicRouter.post('/login'"));
  assert.match(register, /where:\s*\{\s*code:\s*'starter',\s*is_active:\s*true\s*\}/);
  assert.doesNotMatch(register, /code:\s*payload\.planCode/);
  assert.doesNotMatch(register, /plan_id:\s*req\.body/);
});

test('platform plan reassignment remains separately authorized and audited', () => {
  assert.match(platform, /platformRouter\.use\(\(req, _res, next\) =>/);
  assert.match(platform, /isPlatformAdministrator\(req\.auth\)/);
  assert.match(platform, /plan_id:\s*z\.string\(\)\.uuid\(\)\.optional\(\)/);
  assert.match(platform, /platform\.tenant\.lifecycle_updated/);
});
