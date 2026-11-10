import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  LOGIN_PERF_FLAG, LOGIN_PERF_SCALES, LOGIN_PERF_SAMPLES,
  assertLoginPerfConfig, measuredPercentile
} from '../benchmark-login-membership-discovery.mjs';

const safe={
  CI:'true', GITHUB_ACTIONS:'true',
  SEDEAGRO_LOGIN_PERF_PROBE:LOGIN_PERF_FLAG,
  TEST_DATABASE_ADMIN_URL:'postgres://owner:temporary@127.0.0.1:5432/sedeagro_test',
  TEST_DATABASE_APP_URL:'postgres://app:temporary@127.0.0.1:5432/sedeagro_test'
};

test('allow only explicit GitHub disposable loopback test DB with nonowner role',()=>{
  assert.deepEqual(assertLoginPerfConfig(safe),
    {ownerUrl:safe.TEST_DATABASE_ADMIN_URL,runtimeUrl:safe.TEST_DATABASE_APP_URL});
  for(const invalid of [
    {CI:'false'}, {GITHUB_ACTIONS:'false'},
    {SEDEAGRO_LOGIN_PERF_PROBE:'1'},
    {TEST_DATABASE_APP_URL:'postgres://app:p@prod.example.com:5432/sedeagro_test'},
    {TEST_DATABASE_ADMIN_URL:'postgres://owner:p@localhost:5432/sedeagro'},
    {TEST_DATABASE_APP_URL:'postgres://owner:p@127.0.0.1:5432/sedeagro_test'},
    {TEST_DATABASE_APP_URL:'postgres://app:p@127.0.0.1:5432/other_test'},
    {TEST_DATABASE_APP_URL:'postgres://app:p@127.0.0.1:6432/sedeagro_test'},
    {TEST_DATABASE_APP_URL:'postgres://app:p@localhost:5432/sedeagro_test'},
    {TEST_DATABASE_APP_URL:'postgres://app:p@127.0.0.1:5432/sedeagro_test?sslmode=disable'},
    {TEST_DATABASE_APP_URL:'postgres://app:p@127.0.0.1:5432/sedeagro_test#bypass'},
    {TEST_DATABASE_APP_URL:'garbage'},
    {TEST_DATABASE_ADMIN_URL:''}
  ]) assert.throws(()=>assertLoginPerfConfig({...safe,...invalid}),/BLOCKED/);
});

test('latency percentiles use raw measured nearest-rank samples and cannot invent results',()=>{
  const values=[2,5,1,8,3,9,6];
  assert.equal(measuredPercentile(values,.5),5);
  assert.equal(measuredPercentile(values,.95),9);
  assert.equal(measuredPercentile(values,.99),9);
  assert.deepEqual(values,[2,5,1,8,3,9,6]);
  for(const values of [[],[NaN],[Infinity],[-1],['1'],null])
    assert.throws(()=>measuredPercentile(values,.95),/Invalid measured/);
  for(const fraction of [0,-1,1.1,NaN])
    assert.throws(()=>measuredPercentile([1,2],fraction),/Invalid measured/);
});

test('contract fixes all four scales and never asserts a production SLO',()=>{
  assert.deepEqual(LOGIN_PERF_SCALES,[1,25,100,250]);
  assert.equal(LOGIN_PERF_SAMPLES,7);
  const source=readFileSync(new URL('../benchmark-login-membership-discovery.mjs',
    import.meta.url),'utf8');
  assert.match(source,/LOGIN_DISCOVERY_CAPACITY_LIMIT/);
  assert.match(source,/discoverLoginMemberships/);
  assert.match(source,/isSafeRuntimeDbRole/);
  assert.match(source,/relforcerowsecurity/);
  assert.match(source,/productionSloCertified:false/);
  assert.match(source,/DELETE FROM tenants WHERE id=ANY/);
  assert.doesNotMatch(source,/p95Ms\s*[<>]=?\s*[0-9]/);
});

test('CLI refuses to connect or log credentials without explicit disposable CI opt-in',()=>{
  const cli=fileURLToPath(new URL('../benchmark-login-membership-discovery.mjs',
    import.meta.url));
  const out=spawnSync(process.execPath,[cli],{
    encoding:'utf8',timeout:5000,env:{
      ...process.env,...safe,SEDEAGRO_LOGIN_PERF_PROBE:'NO',
      GITHUB_ACTIONS:'false',TEST_DATABASE_APP_URL:'postgres://secret:NEVER_PRINT_ME@prod.example/sedeagro'
    }});
  assert.equal(out.status,2,out.stderr);
  assert.match(out.stderr,/BLOCKED login membership RLS performance/);
  assert.doesNotMatch(out.stdout+out.stderr,/NEVER_PRINT_ME|secret@|prod.example/);
  assert.doesNotMatch(out.stdout,/LOGIN_MEMBERSHIP_RLS_PERF=/);
});
