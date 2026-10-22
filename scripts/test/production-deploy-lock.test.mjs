import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync,
  rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const helper=fileURLToPath(new URL('../production-deploy-lock.sh',import.meta.url));
const deploy=readFileSync(new URL('../deploy-prod.sh',import.meta.url),'utf8');
const command='set -euo pipefail; source "$1" "$2"; printf "WORK_ENTERED\\n"';
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'sedeagro-lock-rehearsal-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  return {root,dir:join(root,'host-lock')};
}
function attempt(dir,cwd=tmpdir()){
  return spawnSync('bash',['-c',command,'lock-fixture',helper,dir],
    {cwd,encoding:'utf8',timeout:6000,env:{...process.env,
      SEDEAGRO_DEPLOY_LOCK_DIR:'/tmp/WRONG-ENV-OVERRIDE'}});
}
function denied(result){
  assert.equal(result.status,2,result.stdout+' '+result.stderr);
  assert.match(result.stderr,/BLOCKED production deployment lock/);
  assert.doesNotMatch(result.stdout,/WORK_ENTERED/);
}

test('production entry holds one fixed host lock before ANY pull, Docker or migrations',()=>{
  const required='source "$SCRIPT_DIR/production-deploy-lock.sh" /run/lock/sedeagro';
  const offset=deploy.indexOf(required);
  assert.ok(offset>=0);
  for(const operation of ['git pull --ff-only origin main',
    'bash scripts/production-preflight.sh',
    'docker compose build backend frontend',
    'docker compose up -d db redis',
    'docker compose run --rm --no-deps']){
    assert.ok(deploy.indexOf(operation)>offset,
      'exclusive lock must precede '+operation);
  }
  assert.doesNotMatch(deploy,/SEDEAGRO_DEPLOY_LOCK_DIR/);
  assert.match(deploy,/if ! source/);
});

test('acquires a private 0700 namespace, 0600 persistent lock inode and exits normally',t=>{
  const {dir}=fixture(t);
  const first=attempt(dir);
  assert.equal(first.status,0,first.stderr);
  assert.match(first.stdout,/WORK_ENTERED/);
  const second=attempt(dir);
  assert.equal(second.status,0,second.stderr);
  const check=spawnSync('stat',['-c','%a %h',join(dir,'production-deploy.lock')],
    {encoding:'utf8'});
  assert.equal(check.stdout.trim(),'600 1');
  const folder=spawnSync('stat',['-c','%a',dir],{encoding:'utf8'});
  assert.equal(folder.stdout.trim(),'700');
});

test('concurrent contender from a separate checkout is denied until owner exits',async t=>{
  const {root,dir}=fixture(t);
  const holder=spawn('bash',['-c',
    'set -euo pipefail; source "$1" "$2"; echo LOCK_HELD; read -r done',
    'lock-holder',helper,dir],{cwd:root,stdio:['pipe','pipe','pipe']});
  t.after(()=>{if(holder.exitCode===null)holder.kill('SIGKILL');});
  const ready=await new Promise((resolve,reject)=>{
    holder.stdout.once('data',chunk=>{
      chunk.toString().includes('LOCK_HELD')?resolve():reject(new Error(String(chunk)));
    });
    holder.once('error',reject);
    holder.once('exit',code=>reject(new Error('holder exited before lock: '+code)));
  });
  assert.equal(ready,undefined);
  const contender=attempt(dir,tmpdir());
  denied(contender);
  assert.match(contender.stderr,/another release is in progress/);
  holder.stdin.write('finish\n');
  const [code]=await once(holder,'close');
  assert.equal(code,0);
  const after=attempt(dir,root);
  assert.equal(after.status,0,after.stderr);
});

test('reject unsafe namespace: relative paths, symlink directory and loose modes',t=>{
  const {root,dir}=fixture(t);
  denied(attempt('relative'));
  denied(attempt(root+'/../other'));
  mkdirSync(dir,{mode:0o700});
  chmodSync(dir,0o755);
  denied(attempt(dir));
  rmSync(dir,{recursive:true});
  symlinkSync(root,dir);
  denied(attempt(dir));
});

test('rejects symlink, hardlink, and world-readable pre-existing lock files',t=>{
  const {root,dir}=fixture(t);
  mkdirSync(dir,{mode:0o700});
  const file=join(dir,'production-deploy.lock');
  symlinkSync(join(root,'target'),file);
  denied(attempt(dir));
  rmSync(file);
  writeFileSync(file,'keep private',{mode:0o644});
  denied(attempt(dir));
  chmodSync(file,0o600);
  linkSync(file,join(root,'another-link'));
  denied(attempt(dir));
  rmSync(join(root,'another-link'));
  assert.equal(attempt(dir).status,0);
});

test('standalone helper cannot be mistaken for an authorized deploy command',()=>{
  const result=spawnSync('bash',[helper,'/run/lock/sedeagro'],
    {encoding:'utf8',timeout:5000});
  denied(result);
});

test('blocker remains: no synthetic lock grants Security Owner or image release GO',()=>{
  assert.ok(deploy.includes('production-preflight.sh'));
  assert.match(deploy,/docker compose build backend frontend/);
  const trust=JSON.parse(readFileSync(new URL('../security-owner-trust.json',
    import.meta.url),'utf8'));
  assert.deepEqual(trust.trusted_keys,[]);
});
