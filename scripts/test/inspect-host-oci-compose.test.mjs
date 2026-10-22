import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {previewSignedHostCompose} from '../inspect-host-oci-compose.mjs';

const SHA='a'.repeat(40),OTHER='b'.repeat(40);
const DB='postgis/postgis:16-3.4@sha256:44126d872ac91993766c341e369c539e8196614321765d36a6f1bab0419a5fa5';
const REDIS='redis:7-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499';
const id=s=>'sha256:'+s.repeat(64);
const images=['backend','frontend'].map((service,i)=>({
  service,tag:'sedeagro-'+service+'-rc:'+SHA,
  config_id:id(i?'d':'c')
}));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const receipt={
  head:SHA,archive:{name:'sedeagro-images-'+SHA+'.tar',sha256:'e'.repeat(64)},
  images
};
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'sedeagro-compose-preview-test-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  mkdirSync(join(dir,'oci'),{mode:0o700});
  const path=join(dir,'oci','sedeagro-images-'+SHA+'.json');
  const content=JSON.stringify(receipt)+'\n';
  writeFileSync(path,content,{mode:0o600});
  return {dir,path,content};
}
function accepted(content){
  return {
    status:'HOST_SIGNED_OCI_IMAGES_PRESENT_READONLY_NOT_DEPLOYED',
    head:SHA,oci_archive_sha256:receipt.archive.sha256,
    oci_receipt_sha256:digest(content),
    security_receipt_sha256:'f'.repeat(64),
    inspected_image_ids:{backend:images[0].config_id,frontend:images[1].config_id},
    local_docker_context:'default',signed_security_inventory_verified:true,
    images_loaded_during_check:false,containers_created:false,
    image_pull_allowed:false,build_allowed:false,
    security_owner_approved:false,release_go:false,
    time_of_container_create_certified:false,production_deploy_certified:false
  };
}
function baseConfig(){
  return {
    name:'sedeagro',
    services:{
      backend:{build:{context:'/tmp/synthetic/backend'},networks:['sedeagro_internal']},
      db:{image:DB,networks:['sedeagro_internal']},
      frontend:{build:{context:'/tmp/synthetic/frontend'},networks:['fedes-net','sedeagro_internal']},
      redis:{image:REDIS,networks:['sedeagro_internal']}
    },
    volumes:{sedeagro_db:{},sedeagro_redis:{}},
    networks:{'fedes-net':{external:true},sedeagro_internal:{}}
  };
}
function override(base){
  const candidate=structuredClone(base);
  for(const im of images){
    delete candidate.services[im.service].build;
    candidate.services[im.service].image=im.tag;
    candidate.services[im.service].pull_policy='never';
  }
  return candidate;
}
function fakeCompose({mutate,checkArgs}={}){
  const calls=[],base=baseConfig(),candidate=override(base);
  if(mutate)mutate({base,candidate});
  const execute=(args,env)=>{
    calls.push(args);
    assert.deepEqual(args.slice(0,4),['--context','default','compose','-f']);
    assert.ok(args.includes('--no-env-resolution'));
    assert.deepEqual(args.slice(-3),['config','--no-env-resolution','--format','json'].slice(-3));
    assert.equal(env.POSTGRES_PASSWORD,'DISPOSABLE_REVIEW_ONLY');
    assert.equal(env.APP_DB_PASSWORD,'DISPOSABLE_REVIEW_ONLY');
    assert.deepEqual(Object.keys(env).sort(),[
      'COMPOSE_DISABLE_ENV_FILE','COMPOSE_PROFILES','POSTGRES_PASSWORD',
      'APP_DB_PASSWORD','SEDEAGRO_RELEASE_SHA',
      'SEDEAGRO_OCI_BACKEND_IMAGE','SEDEAGRO_OCI_FRONTEND_IMAGE'
    ].sort());
    const isOverride=args.filter(x=>x==='-f').length===2;
    if(checkArgs)checkArgs(args,env);
    return JSON.stringify(isOverride?candidate:base);
  };
  return {execute,calls};
}
async function run(t,{mutate,inspected}={}){
  const {dir,content}=fixture(t);
  const mock=fakeCompose({mutate});
  let checks=0;
  const report=previewSignedHostCompose({
    sha:SHA,evidenceDir:dir,
    inspect:async()=>{checks++;return inspected??accepted(content);},
    execute:mock.execute
  });
  return {report,calls:mock.calls,checks:()=>checks};
}

test('signed host OCI ids match secret-free Compose topology; never production GO',async t=>{
  const a=await run(t);
  const result=await a.report;
  assert.equal(result.status,'HOST_SIGNED_OCI_COMPOSE_PARITY_READONLY_NOT_DEPLOYED');
  assert.equal(result.head,SHA);
  assert.deepEqual(result.inspected_image_ids,
    {backend:images[0].config_id,frontend:images[1].config_id});
  assert.equal(result.production_env_read,false);
  assert.equal(result.production_deploy_certified,false);
  assert.equal(result.time_of_container_create_certified,false);
  assert.equal(result.containers_created,false);
  assert.equal(result.release_go,false);
  assert.equal(a.checks(),1);
  assert.equal(a.calls.length,2);
  for(const call of a.calls)
    assert.ok(!call.some(x=>['build','pull','run','create','up','start','load'].includes(x)));
});

test('missing signatures, swapped host IDs, GO inference deny before Compose',async t=>{
  const {dir,content}=fixture(t);
  for(const changes of [
    {status:'UNSIGNED'}, {head:OTHER}, {oci_receipt_sha256:'1'.repeat(64)},
    {security_receipt_sha256:''}, {local_docker_context:'remote'},
    {signed_security_inventory_verified:false},
    {inspected_image_ids:{backend:id('c'),frontend:id('c')}},
    {images_loaded_during_check:true}, {containers_created:true},
    {security_owner_approved:true}, {release_go:true},
    {time_of_container_create_certified:true},
    {production_deploy_certified:true}, {image_pull_allowed:true}
  ]){
    const mock=fakeCompose();
    await assert.rejects(previewSignedHostCompose({
      sha:SHA,evidenceDir:dir,
      inspect:async()=>({...accepted(content),...changes}),
      execute:mock.execute
    }),/HOST_OCI_COMPOSE_PREVIEW_BLOCKED/);
    assert.equal(mock.calls.length,0);
  }
});

test('receipt tampering after signing and tag/config/archive changes deny',async t=>{
  const {dir,path,content}=fixture(t);
  for(const update of [
    {...receipt,head:OTHER},
    {...receipt,archive:{...receipt.archive,sha256:'f'.repeat(64)}},
    {...receipt,images:images.map((im,i)=>i?{...im,config_id:id('a')}:im)},
    {...receipt,images:images.map((im,i)=>i?{...im,tag:'evil:tag'}:im)}
  ]){
    writeFileSync(path,JSON.stringify(update));
    const mock=fakeCompose();
    await assert.rejects(previewSignedHostCompose({
      sha:SHA,evidenceDir:dir,inspect:async()=>accepted(content),
      execute:mock.execute
    }),/HOST_OCI_COMPOSE_PREVIEW_BLOCKED/);
    assert.equal(mock.calls.length,0);
  }
});

test('unreviewed topology mutations fail: port, network, pin, build, pull',async t=>{
  const attacks=[
    ({candidate})=>{candidate.services.frontend.ports=['8080:80'];},
    ({candidate})=>{candidate.services.backend.build={context:'/tmp/evil'};},
    ({candidate})=>{candidate.services.backend.pull_policy='always';},
    ({candidate})=>{candidate.services.redis.image='redis:latest';},
    ({candidate})=>{candidate.networks['fedes-net'].external=false;},
    ({candidate})=>{candidate.services.frontend.environment={UNREVIEWED:'true'};},
    ({base})=>{base.services.db.ports=['5432:5432'];},
    ({base})=>{base.services.backend.image='foreign:tag';}
  ];
  for(const mutate of attacks){
    const a=await run(t,{mutate});
    await assert.rejects(a.report,/OCI_PRODUCTION_OVERLAY_BLOCKED/);
    assert.equal(a.calls.length,2);
  }
});

test('compose config output must be valid bounded JSON',async t=>{
  const {dir,content}=fixture(t);
  for(const raw of ['', '{broken', 'x'.repeat(512*1024)]){
    let calls=0;
    await assert.rejects(previewSignedHostCompose({
      sha:SHA,evidenceDir:dir,inspect:async()=>accepted(content),
      execute:()=>{calls++;return raw;}
    }),/HOST_OCI_COMPOSE_PREVIEW_BLOCKED/);
    assert.equal(calls,1);
  }
});

test('CLI rejects unsafe Docker/Compose overrides and bad SHA',()=>{
  const cli=fileURLToPath(new URL('../inspect-host-oci-compose.mjs',import.meta.url));
  for(const injected of [
    {DOCKER_HOST:'tcp://docker.example:2375'},
    {DOCKER_CONTEXT:'remote'},
    {COMPOSE_FILE:'/tmp/forged-compose.yml'},
    {COMPOSE_ENV_FILES:'/tmp/host.env'}
  ]){
    const spawned=spawnSync(process.execPath,[cli,'--sha',SHA,
      '--evidence-dir','/tmp/no-evidence'],{
      encoding:'utf8',timeout:10000,env:{...process.env,...injected}
    });
    assert.equal(spawned.status,2);
    assert.match(spawned.stderr,/BLOCKED host OCI Compose preview/);
  }
  const bad=spawnSync(process.execPath,[cli,'--sha','bad',
    '--evidence-dir','/tmp/none'],{encoding:'utf8',timeout:10000});
  assert.equal(bad.status,2);
});

test('real Docker Compose v2 parses committed YAML with synthetic env and exact OCI parity',async t=>{
  const {dir,content}=fixture(t);
  const execute=(args,env)=>execFileSync('docker',args,{
    encoding:'utf8',timeout:15000,maxBuffer:512*1024,
    env:{PATH:process.env.PATH,HOME:process.env.HOME,...env},
    stdio:['ignore','pipe','pipe']
  });
  const report=await previewSignedHostCompose({
    sha:SHA,evidenceDir:dir,inspect:async()=>accepted(content),execute
  });
  assert.equal(report.compose_project,'sedeagro');
  assert.equal(report.preview_uses_synthetic_files,true);
  assert.equal(report.production_deploy_certified,false);
});
