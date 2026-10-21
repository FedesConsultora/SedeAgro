import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../check-report-worker-compose.sh', import.meta.url));
const sha = 'a'.repeat(40);
const tenant = 'ab123456-1234-4234-8234-123456789abc';
function probe(t, mock = 'running|healthy|0|' + sha, overrides = {}) {
  const temp = mkdtempSync(join(tmpdir(),'sedeagro-worker-inspect-'));
  t.after(()=>rmSync(temp,{recursive:true,force:true}));
  const bin = join(temp,'bin'); mkdirSync(bin);
  const docker = join(bin,'docker');
  writeFileSync(docker, '#!/bin/sh\nif [ "$1" = compose ]; then echo aaaaaaaaaaaa; else printf "%s\\n" "$FAKE_INSPECT"; fi\n');
  chmodSync(docker,0o755);
  const env = {
    ...process.env, PATH:bin+':'+process.env.PATH,
    FAKE_INSPECT:mock,
    SEDEAGRO_RELEASE_SHA:sha, REPORT_WORKER_TENANT_ID:tenant,
    SEDEAGRO_REPORT_WORKER_APPROVAL:`START_REPORT_WORKER:${sha}:${tenant}`,
    ...overrides
  };
  return spawnSync('bash',[script],{env,encoding:'utf8',timeout:2000});
}

test('read-only docker inspect approves healthy exact image with zero restarts', t=>{
  const r=probe(t);
  assert.equal(r.status,0,r.stderr);
  assert.match(r.stdout,/PASS report-worker/);
});

test('restart history distinguishes warning and repeated critical failures',t=>{
  const r=probe(t,`running|healthy|1|${sha}`);
  assert.equal(r.status,1);
  assert.match(r.stderr,/WARNING/);
  const k=probe(t,`running|healthy|3|${sha}`);
  assert.equal(k.status,2);
  assert.match(k.stderr,/repeated container restarts/);
});

test('refuses unhealthy, stopped, missing and mismatched SHA containers',t=>{
  for(const payload of [
    `running|unhealthy|0|${sha}`,`exited|healthy|0|${sha}`,
    `running|missing|0|${sha}`,`running|healthy|0|${'b'.repeat(40)}`,
    `running|healthy|wat|${sha}`
  ]){
    const result=probe(t,payload);
    assert.equal(result.status,2,payload);
    assert.doesNotMatch(result.stdout,/PASS/);
  }
});

test('bad approval or tenant refuses before Docker lookup',t=>{
  for(const override of [
    {SEDEAGRO_RELEASE_SHA:sha.slice(2)},
    {REPORT_WORKER_TENANT_ID:'all'},
    {SEDEAGRO_REPORT_WORKER_APPROVAL:'START_REPORT_WORKER:wrong'}
  ]){
    const result=probe(t,`running|healthy|0|${sha}`,override);
    assert.equal(result.status,2);
    assert.doesNotMatch(result.stdout,/PASS/);
  }
});
