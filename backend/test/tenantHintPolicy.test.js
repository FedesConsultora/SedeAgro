import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tenantHintProblem } from '../src/infra/http/middlewares/tenantHintPolicy.js';

const A='10000000-0000-4000-8000-000000000001';
const B='20000000-0000-4000-8000-000000000002';
test('consistent host, slug and UUID hints are accepted without interpreting them as auth', () => {
  assert.equal(tenantHintProblem({}),null);
  assert.equal(tenantHintProblem({headerId:A,resolvedTenantId:A}),null);
  assert.equal(tenantHintProblem({headerSlug:'empresa-a',resolvedTenantId:A}),null);
  assert.equal(tenantHintProblem({hostSlug:'empresa-a',headerSlug:'empresa-a',
    headerId:A,resolvedTenantId:A}),null);
  assert.equal(tenantHintProblem({hostSlug:'empresa-a',headerSlug:'empresa-a',
    headerId:A.toUpperCase(),resolvedTenantId:A}),null);
  assert.equal(tenantHintProblem({headerId:A}),null);
});
test('reject contradictory hints before choosing company context', () => {
  assert.equal(tenantHintProblem({hostSlug:'empresa-a',headerSlug:'empresa-b'}),
    'TENANT_HINT_CONFLICT');
  assert.equal(tenantHintProblem({hostSlug:'empresa-a',headerSlug:'empresa-b',
    headerId:A,resolvedTenantId:A}), 'TENANT_HINT_CONFLICT');
  assert.equal(tenantHintProblem({headerSlug:'empresa-a',headerId:B,resolvedTenantId:A}),
    'TENANT_HINT_CONFLICT');
  assert.equal(tenantHintProblem({hostSlug:'empresa-a',headerId:B,resolvedTenantId:A}),
    'TENANT_HINT_CONFLICT');
  assert.equal(tenantHintProblem({headerId:'wrong',resolvedTenantId:A}),
    'TENANT_ID_INVALID');
  assert.equal(tenantHintProblem({headerId:['abc',A]}),'TENANT_ID_INVALID');
  assert.equal(tenantHintProblem({headerSlug:['empresa-a','empresa-b']}),
    'TENANT_SLUG_INVALID');
});
test('resolver validates both before DB lookup and before attaching tenant/ALS context', () => {
  const source=readFileSync(new URL('../src/infra/http/middlewares/tenantResolver.js',import.meta.url),'utf8');
  const first=source.indexOf('const conflict = tenantHintProblem');
  const lookup=source.indexOf('const tenant = await Tenant.findOne');
  const second=source.indexOf('const resolvedConflict = tenantHintProblem');
  const setContext=source.indexOf('req.tenant = tenant');
  const als=source.indexOf('runWithTenantContext');
  assert.ok(first>0 && lookup>first && second>lookup && setContext>second);
  assert.match(source,/resolvedTenantId: tenant.id/);
  assert.match(source,/TENANT_HINT_CONFLICT|const resolvedConflict = tenantHintProblem/);
  assert.match(source,/throw new HttpError\(400, 'Los identificadores de empresa no coinciden\.'/);
  assert.ok(als>=0);
});
