import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  inspectImmutableRuntimeCompose, validateImmutableRuntimeCompose
} from '../ci-oci-immutable-runtime-compose.mjs';

const SHA='a'.repeat(40),OTHER='f'.repeat(40);
const id=c=>'sha256:'+c.repeat(64);
const images=['backend','frontend'].map((service,i)=>({
  service,tag:'sedeagro-'+service+'-rc:'+SHA,
  config_id:id(i?'b':'c'),os:'linux',architecture:'amd64',
  layers:[id(i?'e':'d')]
}));
const receipt={
  head:SHA,archive:{name:'sedeagro-images-'+SHA+'.tar',sha256:'f'.repeat(64)},
  images
};
const verified={
  status:'CI_OCI_PRODUCTION_TOPOLOGY_OVERLAY_VALIDATED_NOT_DEPLOYED',
  head:SHA,archive_sha256:'f'.repeat(64),
  imported_images:{backend:images[0].config_id,frontend:images[1].config_id},
  secrets_loaded:false,container_started:false,
  production_deploy_certified:false,time_of_use_certified:false,
  security_owner_approved:false
};
const DB='postgis/postgis:16-3.4@sha256:44126d872ac91993766c341e369c539e8196614321765d36a6f1bab0419a5fa5';
const REDIS='redis:7-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499';
function baseline(){return {
  name:'sedeagro',
  volumes:{sedeagro_db:{name:'sedeagro_sedeagro_db'},
    sedeagro_redis:{name:'sedeagro_sedeagro_redis'}},
  networks:{'fedes-net':{external:true,name:'fedes-net'},
    sedeagro_internal:{name:'sedeagro_internal'}},
  services:{
    db:{image:DB,networks:{sedeagro_internal:null}},
    redis:{image:REDIS,networks:{sedeagro_internal:null}},
    backend:{build:{context:'/tmp/backend',target:'prod'},
      networks:{sedeagro_internal:null},environment:{PORT:3001}},
    frontend:{build:{context:'/tmp/frontend',target:'prod'},
      networks:{sedeagro_internal:null,'fedes-net':null}}
  }
};}
function resolved(base,reference){
  const value=structuredClone(base);
  for(const im of images){
    delete value.services[im.service].build;
    value.services[im.service].image=im[reference];
    value.services[im.service].pull_policy='never';
  }
  return value;
}
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'sedeagro-locked-compose-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const receiptPath=join(dir,'sedeagro-images-'+SHA+'.json');
  const bundlePath=join(dir,'sedeagro-images-'+SHA+'.tar');
  writeFileSync(receiptPath,JSON.stringify(receipt),{mode:0o600});
  writeFileSync(bundlePath,'synthetic: signed predecessor is injected',{mode:0o600});
  return {bundlePath,receiptPath};
}
function descriptor(im){
  return {
    Id:im.config_id,Os:'linux',Architecture:'amd64',
    RepoTags:[im.tag],RootFS:{Layers:[...im.layers]},
    Config:{
      Labels:{'org.opencontainers.image.revision':SHA},
      Env:im.service==='backend'?['SEDEAGRO_BUILD_SHA='+SHA]:[]
    }
  };
}
function fakeDocker({transform,alterImage}={}){
  const base=baseline(),calls=[];
  const execute=(args,env)=>{
    calls.push([...args]);
    if(args[0]==='compose'){
      assert.ok(args.includes('config')&&args.includes('--no-env-resolution')&&args.includes('--format'));
      assert.equal(env.COMPOSE_DISABLE_ENV_FILE,'1');
      assert.equal(env.SEDEAGRO_RELEASE_SHA,SHA);
      assert.equal(env.POSTGRES_PASSWORD,'DISPOSABLE_COMPOSE_PREVIEW_ONLY');
      assert.equal(env.APP_DB_PASSWORD,'DISPOSABLE_COMPOSE_PREVIEW_ONLY');
      const options=args.filter(x=>x==='-f').length;
      const ref=env.SEDEAGRO_OCI_BACKEND_IMAGE;
      const view=options===1?base:resolved(base,ref===images[0].tag?'tag':'config_id');
      return JSON.stringify(transform?transform(view,args,env):view);
    }
    assert.deepEqual(args.slice(0,4),['image','inspect','--format','{{json .}}']);
    const im=images.find(i=>i.config_id===args[4]);
    assert.ok(im,'must inspect immutable config ID');
    const image=descriptor(im);
    return JSON.stringify(alterImage?alterImage(image,im,calls):image);
  };
  return {execute,calls};
}
function args(t,options={}){
  const f=fixture(t),d=fakeDocker(options);
  return { ...f,sha:SHA,preview:async()=>verified,
    execute:d.execute, trace:d };
}

test('signed IDs resolve real production topology with no build/pull and no Docker mutation',async t=>{
  const a=args(t);
  const output=await inspectImmutableRuntimeCompose(a);
  assert.equal(output.status,
    'CI_OCI_IMMUTABLE_ID_PRODUCTION_COMPOSE_RESOLVED_NOT_DEPLOYED');
  assert.deepEqual(output.immutable_images,verified.imported_images);
  assert.equal(output.uses_config_ids,true);
  assert.equal(output.referenced_mutable_tags,false);
  assert.equal(output.containers_started,false);
  assert.equal(output.containers_created,false);
  assert.equal(output.live_secrets_loaded,false);
  assert.equal(output.production_go,false);
  assert.equal(output.security_owner_approved,false);
  assert.deepEqual(a.trace.calls.map(c=>c.slice(0,2).join(' ')),[
    'compose -f','compose -f','compose -f',
    'image inspect','image inspect','image inspect','image inspect'
  ]);
  assert.ok(a.trace.calls.every(c=>!c.some(x=>
    ['up','run','start','build','pull','create','load'].includes(x))));
  assert.ok(a.trace.calls.filter(c=>c[0]==='image').every(c=>
    images.some(i=>c.includes(i.config_id))&&
    !c.some(x=>x.includes('-rc:'+SHA))));
});

test('immutable plan only permits two image differences from verified signed tag plan',()=>{
  const base=baseline(),tagged=resolved(base,'tag'),locked=resolved(base,'config_id');
  assert.deepEqual(validateImmutableRuntimeCompose(
    base,tagged,locked,receipt,SHA,verified.imported_images),verified.imported_images);
  for(const mutate of [
    c=>{c.services.backend.image=images[0].tag;},
    c=>{c.services.frontend.image=id('4');},
    c=>{c.services.backend.build={context:'./backend'};},
    c=>{c.services.frontend.pull_policy='always';},
    c=>{c.services.db.image='postgres:latest';},
    c=>{c.services.redis.ports=['6379:6379'];},
    c=>{c.networks['fedes-net'].external=false;},
    c=>{c.volumes.public={};},
    c=>{c.services.extra={image:'bad'};}
  ]){
    const broken=structuredClone(locked);mutate(broken);
    assert.throws(()=>validateImmutableRuntimeCompose(
      base,tagged,broken,receipt,SHA,verified.imported_images),
    /IMMUTABLE_PRODUCTION_COMPOSE_BLOCKED/);
  }
});

test('wrong receipt, SHA, importer identity, owner GO or started container fails before Docker',async t=>{
  const a=args(t);
  for(const bad of [
    {...verified,head:OTHER},
    {...verified,imported_images:{backend:id('4'),frontend:images[1].config_id}},
    {...verified,container_started:true},
    {...verified,security_owner_approved:true},
    {...verified,production_deploy_certified:true},
    {...verified,secrets_loaded:true},
    {...verified,time_of_use_certified:true}
  ]){
    await assert.rejects(inspectImmutableRuntimeCompose({...a,preview:async()=>bad}),
      /IMMUTABLE_PRODUCTION_COMPOSE_BLOCKED/);
  }
  const hostile=structuredClone(receipt);
  hostile.images[0].config_id=id('f');
  writeFileSync(a.receiptPath,JSON.stringify(hostile));
  await assert.rejects(inspectImmutableRuntimeCompose(a),
    /IMMUTABLE_PRODUCTION_COMPOSE_BLOCKED/);
  assert.equal(a.trace.calls.length,0);
});

test('Docker image revision, layers and config ID validated twice by immutable ID',async t=>{
  for(const corrupt of [
    x=>{x.Id=id('4');},
    x=>{x.Os='windows';},
    x=>{x.Architecture='arm64';},
    x=>{x.RepoTags=[];},
    x=>{x.RootFS.Layers=[id('4')];},
    x=>{x.Config.Labels['org.opencontainers.image.revision']=OTHER;},
    (x,im)=>{if(im.service==='backend')x.Config.Env=[];}
  ]){
    const a=args(t,{alterImage:(x,im)=>{corrupt(x,im);return x;}});
    await assert.rejects(inspectImmutableRuntimeCompose(a));
    assert.ok(a.trace.calls.filter(c=>c[0]==='compose').length===3);
  }
});

test('CI-only CLI rejects local or PR invocation before any Docker call or secret output',t=>{
  const f=fixture(t);
  const cli=fileURLToPath(new URL('../ci-oci-immutable-runtime-compose.mjs',import.meta.url));
  const x=spawnSync(process.execPath,[cli,'--sha',SHA,
    '--bundle',f.bundlePath,'--receipt',f.receiptPath],{
    encoding:'utf8',timeout:5000,
    env:{...process.env,CI:'false',GITHUB_ACTIONS:'false',
      JWT_SECRET:'NEVER_PRINT_ME',GH_TOKEN:'NEVER_PRINT_ME'}
  });
  assert.equal(x.status,2,x.stderr);
  assert.match(x.stderr,/BLOCKED immutable OCI Compose/);
  assert.doesNotMatch(x.stdout+x.stderr,/NEVER_PRINT_ME/);
});

test('workflow checks OCI signatures before import, container-create and immutable ID proof',()=>{
  const wf=readFileSync(new URL('../../.github/workflows/postgres-isolation.yml',import.meta.url),'utf8');
  const job=wf.split('  offline-image-import:')[1]||'';
  const signed=job.indexOf('verify-oci-signed-provenance.mjs --sha'),
    imported=job.indexOf('ci-oci-import-rehearsal.mjs --mode fresh'),
    container=job.indexOf('ci-oci-container-creation.mjs --sha'),
    immutable=job.indexOf('ci-oci-immutable-runtime-compose.mjs --sha');
  assert.ok(signed>=0&&imported>signed&&container>imported&&immutable>container);
  assert.doesNotMatch(job,/docker (?:compose (?:up|start|run|build|pull)|container start)\\b/);
  const deploy=readFileSync(new URL('../deploy-prod.sh',import.meta.url),'utf8');
  assert.match(deploy,/docker compose build backend frontend/);
  const admission=readFileSync(new URL('../verify-production-image-admission.mjs',import.meta.url),'utf8');
  assert.match(admission,/deploy-prod.sh rebuilds Docker images/);
});
