import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessRollbackEvidence, parseRollbackFingerprint } from '../rollback-decision.mjs';

const script = fileURLToPath(new URL('../rollback-decision.mjs', import.meta.url));
const migrations = Array.from({length:12}, (_, i) =>
  `20261021${String(i + 1).padStart(4, '0')}_rollback_gate.js`);
const fp = '43|0|' + 'a'.repeat(32);
function fixture() {
  return {
    schema: 'sedeagro-rollback-review-v1',
    release: {
      current_sha: 'a'.repeat(40),
      target_sha: 'b'.repeat(40),
      backup_sha256: 'c'.repeat(64)
    },
    database: {
      live_fingerprint: fp, backup_fingerprint: fp,
      live_migrations: [...migrations],
      backup_migrations: [...migrations],
      target_code_migrations: [...migrations]
    },
    operations: {
      archive_sha256_verified: true,
      writes_quiesced: true,
      post_backup_writes_reconciled: true,
      offline_devices_inventory_complete: true,
      unknown_offline_devices: 0,
      pending_offline_batches: 0
    }
  };
}
const verdict = (changes) => {
  const e = fixture();
  if (changes?.release) Object.assign(e.release, changes.release);
  if (changes?.database) Object.assign(e.database, changes.database);
  if (changes?.operations) Object.assign(e.operations, changes.operations);
  return assessRollbackEvidence(e);
};

test('all evidence can reach human review but never approval or automated restore', () => {
  const result = verdict();
  assert.equal(result.code_only.status, 'OPERATOR_REVIEW_REQUIRED');
  assert.equal(result.database_restore.status, 'OPERATOR_REVIEW_REQUIRED');
  assert.equal(result.certified, false);
  assert.match(result.notice, /NO_DEPLOY_OR_RESTORE_APPROVAL/);
});

test('same-count row changes are detected through full row digest differences', () => {
  const result = verdict({ database: { live_fingerprint:'43|0|'+'d'.repeat(32) } });
  assert.equal(result.code_only.status, 'OPERATOR_REVIEW_REQUIRED');
  assert.equal(result.database_restore.status, 'BLOCKED');
  assert.deepEqual(result.database_restore.reason_codes, ['RESTORE_DATA_DIVERGED']);
});

test('inserted or removed relations and sequence changes also block restore', () => {
  for (const changed of [
    '44|0|'+'a'.repeat(32),
    '43|1|'+'a'.repeat(32),
    '42|0|'+'d'.repeat(32)
  ]) assert.ok(verdict({database:{live_fingerprint:changed}})
    .database_restore.reason_codes.includes('RESTORE_DATA_DIVERGED'));
});

test('rollback code cannot be declared compatible with a missing migration', () => {
  const result = verdict({ database: {target_code_migrations:migrations.slice(0,-1)} });
  assert.deepEqual(result.code_only.reason_codes, ['CODE_SCHEMA_NOT_IDENTICAL']);
  assert.deepEqual(result.database_restore.reason_codes, ['RESTORE_SCHEMA_NOT_TARGET']);
});

test('rollback to mismatched backup schema blocks restoring even if row digest matches', () => {
  const result = verdict({ database: {backup_migrations:migrations.slice(0,-1)} });
  assert.deepEqual(result.database_restore.reason_codes, ['RESTORE_SCHEMA_NOT_TARGET']);
});

test('write quiescence and post-backup write review are independent requirements', () => {
  for (const [key,reason] of [
    ['writes_quiesced','RESTORE_WRITES_NOT_QUIESCED'],
    ['post_backup_writes_reconciled','RESTORE_POST_BACKUP_WRITES_NOT_RECONCILED'],
    ['archive_sha256_verified','RESTORE_ARCHIVE_NOT_VERIFIED']
  ]) {
    const result = verdict({operations:{[key]:false}});
    assert.equal(result.database_restore.status,'BLOCKED');
    assert.ok(result.database_restore.reason_codes.includes(reason));
  }
});

test('zero server writes is not enough while device offline state remains unknown', () => {
  for(const patch of [
    {offline_devices_inventory_complete:false},
    {unknown_offline_devices:2},
    {pending_offline_batches:1}
  ]){
    const result=verdict({operations:patch});
    assert.equal(result.database_restore.status,'BLOCKED');
  }
});

test('invalid or omitted evidence never quietly becomes success', () => {
  const malformed = [
    {release:{current_sha:'a'.repeat(10)}},
    {release:{target_sha:'a'.repeat(40)}},
    {release:{backup_sha256:'secret'}},
    {database:{live_fingerprint:'not-a-fingerprint'}},
    {database:{live_fingerprint:'0|0|'+'a'.repeat(32)}},
    {database:{live_migrations:[]}},
    {database:{live_migrations:[...migrations,migrations.at(-1)]}},
    {database:{target_code_migrations:[...migrations.slice(0,-1),'../bad.js']}},
    {operations:{offline_devices_inventory_complete:'true'}},
    {operations:{unknown_offline_devices:-1}},
    {operations:{pending_offline_batches:null}}
  ];
  for(const patch of malformed){
    assert.throws(()=>verdict(patch),JSON.stringify(patch));
  }
  assert.throws(()=>assessRollbackEvidence({schema:'bad'}));
  assert.deepEqual(parseRollbackFingerprint(fp),{tables:43,sequences:0,digest:'a'.repeat(32)});
});

function cli(t,evidence,flags={}){
  const dir=mkdtempSync(join(tmpdir(),'sedeagro-rollback-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const filename=join(dir,'rollback-evidence.json');
  writeFileSync(filename,JSON.stringify(evidence),{mode:0o600});
  chmodSync(filename,flags.unsafePermissions?0o644:0o600);
  const result=spawnSync(process.execPath,[script,'--evidence',filename],{
    env:{PATH:process.env.PATH},encoding:'utf8',timeout:5000
  });
  return {result,filename};
}

test('CLI accepts bounded private evidence, emits only decision codes, no secrets', t=>{
  const e=fixture();
  e.unknownPrivateNote='postgres://sensitive-password@somehost';
  const {result}=cli(t,e);
  assert.equal(result.status,0,result.stderr);
  const output=JSON.parse(result.stdout);
  assert.equal(output.certified,false);
  assert.doesNotMatch(result.stdout+result.stderr,/sensitive-password|somehost/);
});

test('CLI blocks modified/unsafe evidence with nonzero code',t=>{
  const e=fixture();e.database.live_fingerprint='43|0|'+'f'.repeat(32);
  const {result}=cli(t,e);
  assert.equal(result.status,2);
  assert.match(result.stdout,/RESTORE_DATA_DIVERGED/);
});

test('CLI rejects world-readable evidence without exposing its content',t=>{
  const e=fixture();e.secret='PRIVATE_CREDENTIAL';
  const {result}=cli(t,e,{unsafePermissions:true});
  assert.equal(result.status,2);
  assert.doesNotMatch(result.stdout+result.stderr,/PRIVATE_CREDENTIAL/);
});

test('CLI does not write, modify or delete the evidence file',t=>{
  const e=fixture();
  const {result,filename}=cli(t,e);
  assert.equal(result.status,0);
  assert.deepEqual(JSON.parse(readFileSync(filename,'utf8')),e);
});
