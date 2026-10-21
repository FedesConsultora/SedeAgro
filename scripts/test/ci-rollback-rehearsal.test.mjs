import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../ci-rollback-rehearsal.sh', import.meta.url));
const source = readFileSync(entry,'utf8');
const env = { PATH: process.env.PATH || '/usr/bin:/bin', CI:'true',
  GITHUB_ACTIONS:'true',
  SEDEAGRO_DISPOSABLE_RESTORE:'I_ACCEPT_ONLY_CI_TEST_DATABASES' };

const run = (args=[], overrides={}) => spawnSync('bash',[entry,...args],{
  env:{...env,...overrides},encoding:'utf8',timeout:3000
});

test('dry-only gate refuses missing CI authorization and unknown commands', () => {
  for(const variable of ['CI','GITHUB_ACTIONS','SEDEAGRO_DISPOSABLE_RESTORE']) {
    const e = {...env}; delete e[variable];
    const attempted=spawnSync('bash',[entry,'--check-only'],{
      env:e,encoding:'utf8',timeout:3000
    });
    assert.equal(attempted.status,2,variable);
  }
  for(const args of [[],['--run','sedeagro'],['--production'],['--check-only','--run']]){
    assert.equal(run(args).status,2,args.join(' '));
  }
  assert.equal(run(['--check-only'],{SEDEAGRO_DISPOSABLE_RESTORE:'yes'}).status,2);
});

test('check-only is a true no-side-effect operation, independent of Docker',()=>{
  const r=run(['--check-only'],{CI_POSTGIS_CONTAINER:'NOT_A_CONTAINER'});
  assert.equal(r.status,0,r.stderr);
  assert.match(r.stdout,/no database or Docker operation performed/);
  assert.doesNotMatch(r.stdout,/postgres:\/\//);
});

test('run refuses arbitrary container IDs before any SQL',()=>{
  for(const id of ['prod','sedeagro_db','ab', 'b'.repeat(65),'not-hex'+ 'a'.repeat(30)]) {
    assert.equal(run(['--run'],{CI_POSTGIS_CONTAINER:id}).status,2);
  }
});

test('fixture rehearsal fixed to two disposable DB names and image, restores state on error',()=>{
  assert.match(source,/SOURCE_DB=sedeagro_test/);
  assert.match(source,/BACKUP_DB=sedeagro_restore_test/);
  assert.match(source,/OWNER=sedeagro_owner/);
  assert.match(source,/postgis\/postgis:16-3\.4/);
  assert.match(source,/CI_POSTGIS_CONTAINER/);
  assert.match(source,/trap cleanup EXIT/);
  assert.match(source,/trap 'exit 130' INT/);
  assert.match(source,/trap 'exit 143' TERM/);
  assert.match(source,/fingerprint "\$SOURCE_DB"/);
  assert.match(source,/fingerprint "\$BACKUP_DB"/);
  assert.match(source,/check insert_post_backup/);
  assert.match(source,/check same_count_update/);
  assert.match(source,/check code_schema_drift/);
  assert.match(source,/check offline_unknown/);
  assert.match(source,/check offline_pending/);
  assert.match(source,/DELETE FROM tenants WHERE slug='0p21-ci-only-post-backup-write'/);
  assert.match(source,/UPDATE plans SET name=left/);
  assert.doesNotMatch(source,/docker compose (?:up|down)|deploy-prod\.sh|psql .*\$\{.*DB.*\}/);
});

test('no arbitrary SQL, archive or database argument is accepted',()=>{
  assert.doesNotMatch(source,/\bpg_restore\b|\bdropdb\b|\bcreatedb\b/);
  assert.doesNotMatch(source,/DATABASE_URL|POSTGRES_PASSWORD|BACKUP_PATH|--dbname/);
  assert.equal(run(['--run'],{CI_POSTGIS_CONTAINER:'production'}).status,2);
});
