import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  validateReviewCompose,inspectImportedCompose
} from '../ci-oci-compose-parity.mjs';

const SHA='a'.repeat(40);
const id=a=>'sha256:'+a.repeat(64);
const services=['backend','frontend'];
const images=services.map((service,i)=>({
  service,tag:'sedeagro-'+service+'-rc:'+SHA,
  config_id:id(i?'b':'c'),
  os:'linux',architecture:'amd64',layers:[id('d'),id(i?'1':'2')]
}));
const receipt={head:SHA,archive:{name:'sedeagro-images-'+SHA+'.tar',
  sha256:'e'.repeat(64)},images};
const valid={status:'OFFLINE_BUNDLE_VERIFIED_NOT_DEPLOYED',
  head:SHA,archive_sha256:'e'.repeat(64),
  image_ids:{backend:images[0].config_id,frontend:images[1].config_id},
  registry_digest_certified:false,signed_provenance_certified:false};
function expected(){
  return {name:'sedeagro-oci-review',services:{
    backend:{image:images[0].tag,network_mode:'none',read_only:true,
      pull_policy:'never',entrypoint:['node'],command:['--version']},
    frontend:{image:images[1].tag,network_mode:'none',read_only:true,
      pull_policy:'never',entrypoint:['nginx'],command:['-v']}
  }};
}
const inspect=im=>({Id:im.config_id,RepoTags:[im.tag],Os:'linux',
  Architecture:'amd64',
  Config:{Labels:{'org.opencontainers.image.revision':SHA},
    Env:im.service==='backend'?['SEDEAGRO_BUILD_SHA='+SHA]:[]},
  RootFS:{Layers:im.layers}});
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'sedeagro-compose-oci-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const receiptPath=join(dir,'sedeagro-images-'+SHA+'.json'),
    bundlePath=join(dir,'sedeagro-images-'+SHA+'.tar');
  writeFileSync(receiptPath,JSON.stringify(receipt));
  writeFileSync(bundlePath,'synthetic — mocked offline TAR verifier');
  return {receiptPath,bundlePath};
}
function docker(plan=expected(),onInspect){
  const calls=[];
  const execute=(args,env)=>{
    calls.push(args.slice());
    if(args[0]==='compose'){
      assert.deepEqual(args.slice(0,2),['compose','-f']);
      assert.deepEqual(args.slice(3),['config','--format','json']);
      assert.equal(env.SEDEAGRO_OCI_BACKEND_IMAGE,images[0].tag);
      assert.equal(env.SEDEAGRO_OCI_FRONTEND_IMAGE,images[1].tag);
      return JSON.stringify(plan);
    }
    assert.deepEqual(args.slice(0,4),['image','inspect','--format','{{json .}}']);
    const im=images.find(x=>x.tag===args[4]);
    if(!im)throw Error('unapproved image queried');
    const result=inspect(im);
    return JSON.stringify(onInspect?onInspect(result,im,calls):result);
  };
  return {execute,calls};
}
function props(f,d,more={}){
  return {...f,sha:SHA,execute:d.execute,verify:async()=>valid,...more};
}

test('OCI image-only review resolves two exact imported configs with no image mutation',async t=>{
  const f=fixture(t),d=docker();
  const r=await inspectImportedCompose(props(f,d));
  assert.equal(r.status,'CI_OCI_IMAGE_ONLY_COMPOSE_REVIEW_NOT_DEPLOYED');
  assert.deepEqual(r.imported_images,valid.image_ids);
  assert.equal(r.image_rebuild_allowed,false);
  assert.equal(r.image_pull_allowed,false);
  assert.equal(r.container_started,false);
  assert.equal(r.network_created,false);
  assert.equal(r.signed_release_approval,false);
  assert.equal(r.production_deploy_certified,false);
  assert.equal(r.time_of_use_certified,false);
  assert.deepEqual(d.calls.map(a=>a[0]+':'+a[1]),[
    'compose:-f','image:inspect','image:inspect','image:inspect','image:inspect'
  ]);
  assert.ok(d.calls.every(a=>!/(?:up|run|load|build|pull|create|start|exec)/.test(a[0]+' '+a[1])));
});

test('reject production Compose build, alternate tags, pulls, networks, ports, secrets and privileged',()=>{
  const variants=[
    x=>{x.name='sedeagro';},
    x=>{x.services.backend.build={context:'./backend'};},
    x=>{x.services.frontend.image='nginx:latest';},
    x=>{x.services.backend.image='sha256:'+'f'.repeat(64);},
    x=>{x.services.frontend.pull_policy='always';},
    x=>{x.services.backend.network_mode='bridge';},
    x=>{x.services.backend.ports=['443:80'];},
    x=>{x.services.backend.env_file=['./backend/.env'];},
    x=>{x.services.backend.privileged=true;},
    x=>{x.services.frontend.volumes=['/etc:/data'];},
    x=>{x.services.frontend.read_only=false;},
    x=>{x.services.frontend.command=['sh','-c','bad'];},
    x=>{x.services.redis={image:'redis:latest'};},
    x=>{x.networks={default:{}};},
    x=>{x.volumes={secret:{}};}
  ];
  for(const transform of variants){
    const x=expected();transform(x);
    assert.throws(()=>validateReviewCompose(x,receipt,SHA),
      /OCI_COMPOSE_PARITY_BLOCKED/);
  }
});

test('Docker Compose v2 renders the committed review template with no implicit network or build',t=>{
  const version=spawnSync('docker',['compose','version'],{encoding:'utf8',timeout:5000});
  if(version.status!==0){t.skip('Docker Compose unavailable outside CI runner');return;}
  const compose=fileURLToPath(new URL('../../docker-compose.oci-review.yml',import.meta.url));
  const out=spawnSync('docker',['compose','-f',compose,'config','--format','json'],{
    encoding:'utf8',timeout:10000,
    env:{...process.env,
      SEDEAGRO_OCI_BACKEND_IMAGE:images[0].tag,
      SEDEAGRO_OCI_FRONTEND_IMAGE:images[1].tag}
  });
  assert.equal(out.status,0,out.stderr);
  assert.deepEqual(validateReviewCompose(JSON.parse(out.stdout),receipt,SHA),
    valid.image_ids);
});

test('wrong SHA, duplicate service, wrong config and malformed receipt are rejected',()=>{
  for(const x of [
    {...receipt,head:'f'.repeat(40)},
    {...receipt,images:[images[0],images[0]]},
    {...receipt,images:[images[1],images[0]]},
    {...receipt,images:[{...images[0],config_id:'wrong'},images[1]]},
  ]) assert.throws(()=>validateReviewCompose(expected(),x,SHA),
    /OCI_COMPOSE_PARITY_BLOCKED/);
  assert.throws(()=>validateReviewCompose(expected(),receipt,'invalid'),
    /OCI_COMPOSE_PARITY_BLOCKED/);
});

test('signed archive verification failure does not inspect Docker or Compose',async t=>{
  const f=fixture(t),d=docker();
  for(const bad of [
    {...valid,head:'f'.repeat(40)},
    {...valid,archive_sha256:'wrong'},
    {...valid,status:'unverified'},
    {...valid,signed_provenance_certified:true}
  ]) await assert.rejects(inspectImportedCompose(props(f,d,{
    verify:async()=>bad
  })),/OCI_COMPOSE_PARITY_BLOCKED/);
  assert.equal(d.calls.length,0);
});

test('receipt, archive hash and expected image ids must match before Docker',async t=>{
  const f=fixture(t),d=docker();
  for(const alteration of [
    x=>{x.archive.sha256='f'.repeat(64);},
    x=>{x.archive.name='other.tar';},
    x=>{x.images[0].config_id=id('f');},
  ]){
    const original=structuredClone(receipt);
    alteration(original);
    writeFileSync(f.receiptPath,JSON.stringify(original));
    await assert.rejects(inspectImportedCompose(props(f,d)),
      /OCI_COMPOSE_PARITY_BLOCKED/);
  }
  assert.equal(d.calls.length,0);
});

test('real daemon tag substitution, changed image ID, rootfs or backend revision is rejected',async t=>{
  const f=fixture(t);
  for(const mutation of ['id','layers','revision','tag','lateRetag']){
    const d=docker(expected(),(image,im,calls)=>{
      if(im.service==='backend' &&
        (mutation!=='lateRetag'||calls.filter(a=>a[0]==='image').length>2)){
        if(mutation==='id'||mutation==='lateRetag')image.Id=id('f');
        if(mutation==='layers')image.RootFS.Layers=[id('f')];
        if(mutation==='revision')image.Config.Labels['org.opencontainers.image.revision']='f'.repeat(40);
        if(mutation==='tag')image.RepoTags=[];
      }
      return image;
    });
    await assert.rejects(inspectImportedCompose(props(f,d)),/OCI_IMPORT_BLOCKED/);
    assert.ok(d.calls.every(x=>!['load','run','pull','build','up'].includes(x[1])));
  }
});

test('CLI outside exact SHA main GitHub CI cannot access Docker or print secrets',t=>{
  const f=fixture(t);
  const cli=fileURLToPath(new URL('../ci-oci-compose-parity.mjs',import.meta.url));
  const p=spawnSync(process.execPath,[cli,'--sha',SHA,'--bundle',f.bundlePath,
    '--receipt',f.receiptPath],{encoding:'utf8',timeout:6000,
    env:{...process.env,CI:'false',GITHUB_ACTIONS:'false',
      GH_TOKEN:'DO_NOT_PRINT_SECRETS',JWT_SECRET:'DO_NOT_PRINT_SECRETS'}});
  assert.equal(p.status,2,p.stderr);
  assert.match(p.stderr,/BLOCKED OCI Compose parity/);
  assert.doesNotMatch(p.stderr+p.stdout,/DO_NOT_PRINT_SECRETS/);
});

test('committed Compose is isolated; workflow orders signed import before image-consumer review',()=>{
  const src=readFileSync(new URL('../../docker-compose.oci-review.yml',import.meta.url),'utf8');
  const prod=readFileSync(new URL('../../docker-compose.yml',import.meta.url),'utf8');
  const wf=readFileSync(new URL('../../.github/workflows/postgres-isolation.yml',import.meta.url),'utf8');
  const receiver=wf.split('  offline-image-import:')[1]||'';
  assert.match(src,/name: sedeagro-oci-review/);
  assert.match(src,/network_mode: none/g);
  assert.match(src,/pull_policy: never/g);
  assert.doesNotMatch(src,/(?:\bbuild:|\bports:|\bvolumes:|network_mode: host)/);
  assert.match(prod,/^\s+build:\s*$/m);
  const sig=receiver.indexOf('verify-oci-signed-provenance.mjs');
  const security=receiver.indexOf('verify-image-security.mjs --mode verify-signed');
  const imp=receiver.indexOf('ci-oci-import-rehearsal.mjs --mode fresh');
  const parity=receiver.indexOf('ci-oci-compose-parity.mjs --sha');
  assert.ok(sig>=0 && security>sig && imp>security && parity>imp);
  assert.doesNotMatch(receiver,/\bdocker (?:compose up|compose build|run|pull|push)\b/);
});
