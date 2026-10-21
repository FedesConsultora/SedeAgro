import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  rmSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const shell=fileURLToPath(new URL('../ci-independent-recovery.sh',import.meta.url));
const rls=fileURLToPath(new URL('../sql/ci-independent-recovery-rls.sql',import.meta.url));
const source=readFileSync(shell,'utf8');
const sql=readFileSync(rls,'utf8');

const env={PATH:process.env.PATH||'/usr/bin:/bin',CI:'true',GITHUB_ACTIONS:'true',
  SEDEAGRO_DISPOSABLE_RESTORE:'I_ACCEPT_ONLY_CI_TEST_DATABASES',
  SEDEAGRO_INDEPENDENT_RECOVERY:'I_ACCEPT_NETWORKLESS_CI_RECOVERY'};
const run=(args,patch={})=>spawnSync('bash',[shell,...args],{
  encoding:'utf8',env:{...env,...patch},timeout:5000
});

test('all four independent CI-only approvals are mandatory',()=>{
  for(const k of ['CI','GITHUB_ACTIONS','SEDEAGRO_DISPOSABLE_RESTORE',
    'SEDEAGRO_INDEPENDENT_RECOVERY']){
    const e={...env};delete e[k];
    const r=spawnSync('bash',[shell,'--check-only'],{
      encoding:'utf8',env:e,timeout:5000
    });
    assert.equal(r.status,2,k);
    assert.match(r.stderr,/BLOCKED/);
  }
  assert.equal(run(['--check-only'],{SEDEAGRO_INDEPENDENT_RECOVERY:'true'}).status,2);
  assert.equal(run(['--check-only'],{GITHUB_ACTIONS:'false'}).status,2);
});

test('check-only never needs an archive, Docker, network or DB',()=>{
  const r=run(['--check-only']);
  assert.equal(r.status,0,r.stderr);
  assert.match(r.stdout,/no Docker, files or database touched/);
  assert.doesNotMatch(r.stdout,/postgres:\/\//);
});

test('refuses extra arguments, arbitrary paths and user-supplied database names',()=>{
  for(const args of [[],['--run','--database=production'],['--restore'],
    ['--check-only','--run']]){
    assert.equal(run(args).status,2,args.join(' '));
  }
  for(const path of ['/srv/backups/real.dump','/home/user/secret.dump',
    '/var/tmp/real.dump','postgres://production/db']){
    const r=run(['--run'],{
      CI_POSTGIS_CONTAINER:'a'.repeat(64),
      CI_RECOVERY_ARCHIVE:path,
      CI_RECOVERY_ARCHIVE_SHA256:'b'.repeat(64),
      CI_RECOVERY_EXPECTED_DATA:'43|0|'+'c'.repeat(32),
      CI_RECOVERY_EXPECTED_CATALOG:'d'.repeat(32)+':12:2:3:30:30'
    });
    assert.equal(r.status,2);
  }
});

test('no missing, malformed or fake fingerprints advance to Docker',()=>{
  const valid={
    CI_POSTGIS_CONTAINER:'a'.repeat(64),
    CI_RECOVERY_ARCHIVE:'/tmp/ci-nonexistent.dump',
    CI_RECOVERY_ARCHIVE_SHA256:'a'.repeat(64),
    CI_RECOVERY_EXPECTED_DATA:'43|0|'+'b'.repeat(32),
    CI_RECOVERY_EXPECTED_CATALOG:'c'.repeat(32)+':12:2:3:30:30'
  };
  for(const patch of [
    {CI_POSTGIS_CONTAINER:'production'},
    {CI_RECOVERY_ARCHIVE_SHA256:'malformed'},
    {CI_RECOVERY_EXPECTED_DATA:'not a digest'},
    {CI_RECOVERY_EXPECTED_CATALOG:'12:23'},
    {CI_RECOVERY_ARCHIVE:'/tmp/not_there.dump'}
  ]){
    const r=run(['--run'],{...valid,...patch});
    assert.equal(r.status,2);
    assert.doesNotMatch(r.stdout,/PASS CI-independent recovery/);
  }
});

function fixture(t,{fakeNetwork='bridge',unsafeArchive=false}={}){
  const root=mkdtempSync(join(tmpdir(),'sedeagro-ci-0p23-'));
  t.after(()=>rmSync(root,{force:true,recursive:true}));
  chmodSync(root,0o700);
  const bin=join(root,'bin');mkdirSync(bin,{mode:0o700});
  const archive=join(root,'fixture.dump');
  writeFileSync(archive,Buffer.alloc(8192,0x43),{mode:unsafeArchive?0o644:0o600});
  chmodSync(archive,unsafeArchive?0o644:0o600);
  const checksum=createHash('sha256').update(readFileSync(archive)).digest('hex');
  const calls=join(root,'docker.calls');
  const mock=join(bin,'docker');
  const mockSource=[
    '#!/usr/bin/env bash',
    'printf "%s\\n" "$1" >> "$MOCK_DOCKER_CALLS"',
    'if [[ "$1" == inspect ]]; then',
    '  case "$*" in',
    '    *Config.Image*) echo postgis/postgis:16-3.4 ;;',
    '    *HostConfig.NetworkMode*) echo "$MOCK_DOCKER_NETWORK" ;;',
    '    *PortBindings*) echo 0 ;;',
    '    *Mounts*) echo "volume:/var/lib/postgresql/data " ;;',
    '  esac',
    '  exit 0',
    'fi',
    'if [[ "$1" == run ]]; then echo "'+'b'.repeat(64)+'"; exit 0; fi',
    'if [[ "$1" == stop ]]; then exit 0; fi',
    'exit 88',
    ''
  ].join('\n');
  writeFileSync(mock,mockSource,{mode:0o700});
  chmodSync(mock,0o700);
  const fixtureEnv={
    PATH:bin+':'+env.PATH,MOCK_DOCKER_CALLS:calls,MOCK_DOCKER_NETWORK:fakeNetwork,
    CI_POSTGIS_CONTAINER:'a'.repeat(64),
    CI_RECOVERY_ARCHIVE:archive,
    CI_RECOVERY_ARCHIVE_SHA256:checksum,
    CI_RECOVERY_EXPECTED_DATA:'43|0|'+'a'.repeat(32),
    CI_RECOVERY_EXPECTED_CATALOG:'b'.repeat(32)+':12:2:3:30:30'
  };
  return {root,bin,calls,archive,fixtureEnv};
}

test('refuses unsafe archive permissions before any Docker command',t=>{
  const f=fixture(t,{unsafeArchive:true});
  const r=run(['--run'],f.fixtureEnv);
  assert.equal(r.status,2,r.stderr);
  assert.equal(existsSync(f.calls),false);
});

test('refuses tampered archive SHA256 before any Docker command',t=>{
  const f=fixture(t);
  writeFileSync(f.archive,Buffer.alloc(8192,0x42));
  const r=run(['--run'],f.fixtureEnv);
  assert.equal(r.status,2,r.stderr);
  assert.equal(existsSync(f.calls),false);
});

test('actually invokes independent container and rejects a Docker network misconfiguration',t=>{
  const f=fixture(t,{fakeNetwork:'bridge'});
  const r=run(['--run'],f.fixtureEnv);
  assert.equal(r.status,2,r.stderr);
  assert.match(r.stderr,/BLOCKED/);
  assert.doesNotMatch(r.stdout+r.stderr,/temporary-ci-independent-recovery-password/);
  const invoked=readFileSync(f.calls,'utf8');
  assert.match(invoked,/run/);
  assert.match(invoked,/inspect/);
  assert.match(invoked,/stop/);
  assert.doesNotMatch(invoked,/exec/);
});

test('source code pins a second, networkless, disposable PostGIS and cleans up',()=>{
  assert.match(source,/--detach --rm --pull never --network none/);
  assert.match(source,/--pids-limit 256 --memory 1g/);
  assert.match(source,/postgis\/postgis:16-3\.4/);
  assert.match(source,/\{\{\.HostConfig.NetworkMode\}\}/);
  assert.match(source,/\{\{len \.HostConfig.PortBindings\}\}/);
  assert.match(source,/\{\{range \.Mounts\}\}/);
  assert.match(source,/trap cleanup EXIT/);
  assert.match(source,/docker stop --time 5/);
  assert.match(source,/pg_restore --exit-on-error --no-owner --no-acl/);
  assert.match(source,/sha256sum "\$ARCHIVE"/);
  assert.match(source,/restore-data-fingerprint\.sql/);
  assert.match(source,/ci-independent-recovery-rls\.sql/);
  assert.match(source,/provision-runtime-role\.sql/);
  assert.doesNotMatch(source,/docker compose|deploy-prod\.sh|\bdropdb\b|\bcreatedb\b/);
  assert.doesNotMatch(source,/docker (?:push|pull)|--publish|\-p 5432/);
});

test('real SQL remains transactional, fixed to CI DB, owner and real app-role FORCE RLS',()=>{
  assert.match(sql,/current_database\(\) <> 'sedeagro_restore_test'/);
  assert.match(sql,/session_user <> 'sedeagro_owner'/);
  assert.match(sql,/SET LOCAL ROLE sedeagro_app/);
  assert.match(sql,/row_security_active/);
  assert.match(sql,/rolbypassrls/);
  assert.match(sql,/set_config\('app.current_tenant'/);
  assert.match(sql,/GET DIAGNOSTICS affected = ROW_COUNT/);
  assert.match(sql,/ROLLBACK;/);
  assert.match(sql,/^BEGIN;/m);
  assert.doesNotMatch(sql,/DROP DATABASE|CREATE TABLE public|TRUNCATE|COMMIT;/i);
});
