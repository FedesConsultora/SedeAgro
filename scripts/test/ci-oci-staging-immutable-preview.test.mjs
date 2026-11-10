import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  validateImmutableStagingCompose,inspectImmutableStagingCompose
} from '../ci-oci-staging-immutable-preview.mjs';

const SHA='a'.repeat(40),OTHER='b'.repeat(40),id=s=>'sha256:'+s.repeat(64);
const ids={backend:id('c'),frontend:id('d')};
const archive='f'.repeat(64);
const receipt={head:SHA,archive:{name:'sedeagro-images-'+SHA+'.tar',sha256:archive},
  images:[{service:'backend',config_id:ids.backend},
    {service:'frontend',config_id:ids.frontend}]};
const review=()=>({
  status:'CI_OCI_IMMUTABLE_ID_PRODUCTION_COMPOSE_RESOLVED_NOT_DEPLOYED',
  head:SHA,archive_sha256:archive,immutable_images:ids,
  uses_config_ids:true,referenced_mutable_tags:false,
  real_production_compose_checked:true,
  containers_started:false,containers_created:false,
  production_go:false,security_owner_approved:false,
  staging_certified:false,time_of_use_certified:false
});
const accepted=()=>({
  status:'CONFIG_REVIEW_REQUIRED',project:'sedeagro-staging',
  release_sha:SHA,runtime_certified:false
});
function base(){
  return {name:'sedeagro-staging',
    services:{
      db:{image:'sha256:postgres',networks:{staging_internal:null}},
      redis:{image:'sha256:redis',networks:{staging_internal:null}},
      backend:{image:'sedeagro-staging-backend:'+SHA,
        build:{context:'/ci/backend',target:'prod'},
        networks:{staging_internal:{aliases:['sedeagro_backend']}},
        environment:{NODE_ENV:'production'}},
      frontend:{image:'sedeagro-staging-frontend:'+SHA,
        build:{context:'/ci/frontend',target:'prod'},
        networks:{staging_internal:null},ports:[{host_ip:'127.0.0.1',published:'4183',target:80}]}
    },
    networks:{staging_internal:{internal:true}},
    volumes:{staging_pgdata:{},staging_redisdata:{}}
  };
}
function locked(input){
  const r=structuredClone(input);
  for(const name of ['backend','frontend']){
    delete r.services[name].build;
    r.services[name].image=ids[name];
    r.services[name].pull_policy='never';
  }
  return r;
}
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'sedeagro-oci-staging-test-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const receiptPath=join(dir,'sedeagro-images-'+SHA+'.json'),
    bundlePath=join(dir,'sedeagro-images-'+SHA+'.tar');
  writeFileSync(receiptPath,JSON.stringify(receipt));
  writeFileSync(bundlePath,'synthetic signed bundle not executed in tests');
  return {receiptPath,bundlePath};
}
const options=t=>({sha:SHA,...fixture(t),review:async()=>review()});

test('pure topology check only replaces backend/frontend builds with sha256 IDs',()=>{
  const baseline=base(),candidate=locked(baseline);
  assert.deepEqual(validateImmutableStagingCompose(
    baseline,candidate,ids,SHA,accepted),ids);
  for(const mutate of [
    c=>{c.services.backend.image='sedeagro-staging-backend:'+SHA;},
    c=>{c.services.frontend.image=id('1');},
    c=>{c.services.backend.build={context:'/ci/evil'};},
    c=>{c.services.frontend.pull_policy='always';},
    c=>{c.services.db.image='postgres:latest';},
    c=>{c.services.redis.ports=['6379:6379'];},
    c=>{c.services.frontend.ports=[{host_ip:'0.0.0.0',published:'4183',target:80}];},
    c=>{c.services.backend.environment.NODE_ENV='development';},
    c=>{c.networks.staging_internal.internal=false;},
    c=>{c.volumes.public={};},
    c=>{c.services.extra={image:'untrusted:tag'};}
  ]){
    const result=structuredClone(candidate);mutate(result);
    assert.throws(()=>validateImmutableStagingCompose(
      baseline,result,ids,SHA,accepted),/STAGING_SIGNED_OCI_PARITY_BLOCKED/);
  }
  assert.throws(()=>validateImmutableStagingCompose(
    baseline,candidate,{backend:id('c'),frontend:id('c')},SHA,accepted),
  /STAGING_SIGNED_OCI_PARITY_BLOCKED/);
  assert.throws(()=>validateImmutableStagingCompose(
    baseline,candidate,ids,OTHER,accepted),
  /STAGING_SIGNED_OCI_PARITY_BLOCKED/);
});

test('CI proof and receipt must match before Docker Compose config is read',async t=>{
  for(const edit of [
    {status:'UNSIGNED'}, {head:OTHER}, {archive_sha256:'bad'},
    {uses_config_ids:false},{referenced_mutable_tags:true},
    {real_production_compose_checked:false},
    {containers_started:true},{containers_created:true},
    {production_go:true},{security_owner_approved:true},
    {staging_certified:true},{time_of_use_certified:true}
  ]){
    let calls=0;
    await assert.rejects(inspectImmutableStagingCompose({
      ...options(t),review:async()=>({...review(),...edit}),
      execute:()=>{calls++;return '{}';}
    }),/STAGING_SIGNED_OCI_PARITY_BLOCKED/);
    assert.equal(calls,0);
  }
  const f=options(t),changed={...receipt,head:OTHER};
  writeFileSync(f.receiptPath,JSON.stringify(changed));
  let calls=0;
  await assert.rejects(inspectImmutableStagingCompose({
    ...f,execute:()=>{calls++;return '{}';}
  }),/STAGING_SIGNED_OCI_PARITY_BLOCKED/);
  assert.equal(calls,0);
});

test('real Docker Compose v2 parses the committed staging base and ID-only overlay',async t=>{
  const f=options(t);
  const execute=(args,env)=>{
    assert.deepEqual(args.slice(0,4),['compose','--env-file','/dev/null','-f']);
    assert.equal(env.COMPOSE_DISABLE_ENV_FILE,'1');
    assert.equal(env.SEDEAGRO_STAGING_HOST,'staging.ci.test');
    assert.equal(env.SEDEAGRO_STAGING_SHA,SHA);
    assert.equal(env.SEDEAGRO_OCI_BACKEND_IMAGE,ids.backend);
    assert.equal(env.SEDEAGRO_OCI_FRONTEND_IMAGE,ids.frontend);
    assert.equal(env.SEDEAGRO_STAGING_OWNER_PASSWORD,
      '8v7XqaWn3Fpr6Kjh9MNpQ5aZ2R4uLc');
    assert.ok(!args.some(x=>['up','run','build','pull','start'].includes(x)));
    return execFileSync('docker',args,{encoding:'utf8',timeout:20000,
      maxBuffer:512*1024,env:{PATH:process.env.PATH,HOME:process.env.HOME,...env},
      stdio:['ignore','pipe','pipe']});
  };
  const result=await inspectImmutableStagingCompose({...f,execute});
  assert.equal(result.status,'CI_SIGNED_OCI_IMMUTABLE_STAGING_COMPOSE_PARITY_NOT_DEPLOYED');
  assert.deepEqual(result.signed_image_ids,ids);
  assert.equal(result.private_network_preserved,true);
  assert.equal(result.staging_loopback_port_preserved,true);
  assert.equal(result.production_env_read,false);
  assert.equal(result.containers_created,false);
  assert.equal(result.staging_certified,false);
  assert.equal(result.production_go,false);
});

test('unexpected third service or changed Redis/port is denied even with synthetic validator',async t=>{
  const f=options(t),baseline=base(),candidate=locked(baseline);
  for(const edit of [
    c=>{c.services.extra={image:'evil'};},
    c=>{c.services.redis.command=['redis-server','--disable-auth'];},
    c=>{c.services.backend.environment.PASSWORD='leaked';},
    c=>{c.services.frontend.ports=[{host_ip:'0.0.0.0',target:80,published:'4183'}];}
  ]){
    let calls=0;
    await assert.rejects(inspectImmutableStagingCompose({
      ...f,validate:accepted,
      execute:()=>{calls++;return JSON.stringify(calls===1?baseline:
        (()=>{const c=structuredClone(candidate);edit(c);return c;})());}
    }),/STAGING_SIGNED_OCI_PARITY_BLOCKED/);
    assert.equal(calls,2);
  }
});

test('CLI rejects all local and non-main invocation before staging/host interaction',t=>{
  const f=options(t),cli=fileURLToPath(new URL('../ci-oci-staging-immutable-preview.mjs',import.meta.url));
  const p=spawnSync(process.execPath,[cli,'--sha',SHA,'--bundle',
    f.bundlePath,'--receipt',f.receiptPath],{
    encoding:'utf8',timeout:5000,
    env:{...process.env,CI:'false',GITHUB_ACTIONS:'false',
      SECRET:'DO_NOT_PRINT_THIS'}
  });
  assert.equal(p.status,2,p.stderr);
  assert.match(p.stderr,/BLOCKED staging signed OCI preview/);
  assert.doesNotMatch(p.stdout+p.stderr,/DO_NOT_PRINT_THIS/);
});

test('signed staging proof happens after OCI import/immutable image config and no live up',()=>{
  const wf=readFileSync(new URL('../../.github/workflows/postgres-isolation.yml',import.meta.url),'utf8');
  const job=wf.split('  offline-image-import:')[1]||'';
  const signed=job.indexOf('verify-oci-signed-provenance.mjs --sha'),
    imported=job.indexOf('ci-oci-import-rehearsal.mjs --mode fresh'),
    immutable=job.indexOf('ci-oci-immutable-runtime-compose.mjs --sha'),
    stage=job.indexOf('ci-oci-staging-immutable-preview.mjs --sha');
  assert.ok(signed>=0&&imported>signed&&immutable>imported&&stage>immutable);
  assert.doesNotMatch(job,/docker compose (?:up|run|start|pull|build)/);
});
