import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HTTP_LOAD_FLAG, HTTP_LOAD_CASES, HTTP_LOAD_SIZE, HTTP_LOAD_SAMPLES,
  assertHttpLoadConfig, percentile, validateReviewPage, makeReviewUrl
} from '../benchmark-review-queue-http.mjs';

const safe = {
  CI: 'true', GITHUB_ACTIONS: 'true', SEDEAGRO_HTTP_LOAD_PROBE: HTTP_LOAD_FLAG,
  TEST_DATABASE_ADMIN_URL: 'postgres://owner:temporary@127.0.0.1:5432/sedeagro_test',
  TEST_DATABASE_APP_URL: 'postgres://app:temporary@localhost:5432/sedeagro_test'
};
const id = '01234567-89ab-4cde-8f01-234567890abc';
const fake = (count=50, more=true) => ({
  data: Array.from({length:count}, (_,i) => ({
    id: '01234567-89ab-4cde-8f01-' + String(i+1).padStart(12,'0')
  })),
  pagination: {page_size:50, has_more:more, next_cursor:more?'a'.repeat(45):null}
});

test('cannot profile production, external hosts, or database with admin runtime role', () => {
  assert.equal(assertHttpLoadConfig(safe), true);
  for (const patch of [
    {CI:undefined}, {GITHUB_ACTIONS:'false'}, {SEDEAGRO_HTTP_LOAD_PROBE:'yes'},
    {TEST_DATABASE_APP_URL:'postgres://app:pass@prod.example.com:5432/sedeagro_test'},
    {TEST_DATABASE_ADMIN_URL:'postgres://owner:pass@127.0.0.1:5432/sedeagro'},
    {TEST_DATABASE_APP_URL:'postgres://app:pass@127.0.0.1:5432/staging_test'},
    {TEST_DATABASE_APP_URL:'postgres://owner:pass@127.0.0.1:5432/sedeagro_test'},
    {TEST_DATABASE_APP_URL:'invalid'}
  ]) assert.throws(()=>assertHttpLoadConfig({...safe,...patch}), /BLOCKED/);
});

test('p50 p95 p99 use measured nearest-rank samples and never alter input', () => {
  const timings=[4,2,11,3,6,10,5];
  assert.equal(percentile(timings,.5),5);
  assert.equal(percentile(timings,.95),11);
  assert.equal(percentile(timings,.99),11);
  assert.deepEqual(timings,[4,2,11,3,6,10,5]);
  for (const sample of [[],[-1],[NaN],[Infinity],['10']])
    assert.throws(()=>percentile(sample,.95),/Invalid real HTTP latency/);
});

test('bounded API page validates HMAC cursor contract and unique UUIDs', () => {
  assert.equal(validateReviewPage(fake()).length, 50);
  assert.equal(validateReviewPage(fake(17,false)).length, 17);
  for (const bad of [
    fake(51,true), fake(1,true),
    {...fake(),pagination:{...fake().pagination,next_cursor:'short'}},
    {...fake(),data:[{id:'invalid'}]},
    {...fake(),data:[{id}] .concat([{id}])},
    {...fake(1,false),pagination:{page_size:50,has_more:false,next_cursor:'bogus'}}
  ]) assert.throws(()=>validateReviewPage(bad));
  assert.throws(()=>validateReviewPage(null));
});

test('real-load query URL keeps static loopback target and bounds allowed filters', () => {
  const base='http://127.0.0.1:4177/api/v1/work-orders/review-queue';
  const query=new URL(makeReviewUrl(base,
    {sort:'due_first',type:'application',state:'blocked'},'a'.repeat(45)));
  assert.equal(query.hostname,'127.0.0.1');
  assert.equal(query.searchParams.get('q'),'PilotLoad');
  assert.equal(query.searchParams.get('cursor'),'a'.repeat(45));
  assert.equal(query.searchParams.get('state'),'blocked');
  assert.throws(()=>makeReviewUrl('https://prod.example.com/api/v1/work-orders/review-queue',{}),/BLOCKED/);
  assert.throws(()=>makeReviewUrl(base,{tenant:'wrong'}),/BLOCKED/);
  assert.throws(()=>makeReviewUrl(base,{},'short'),/BLOCKED/);
  assert.equal(HTTP_LOAD_CASES.length,9);
  assert.equal(HTTP_LOAD_SIZE,5000);
  assert.equal(HTTP_LOAD_SAMPLES,7);
});
