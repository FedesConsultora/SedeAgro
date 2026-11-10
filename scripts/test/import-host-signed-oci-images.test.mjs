import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,chmodSync,readFileSync,rmSync,writeFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectHostSignedOciImport} from '../import-host-signed-oci-images.mjs';

const SHA='a'.repeat(40),OTHER='b'.repeat(40),id=s=>'sha256:'+s.repeat(64);
const H=bytes=>createHash('sha256').update(bytes).digest('hex');
const images=['backend','frontend'].map((service,i)=>({
  service,tag:'sedeagro-'+service+'-rc:'+SHA,config_id:id(i?'c':'d'),
  os:'linux',architecture:'amd64',layers:[id(i?'f':'e')]
}));
const receipt={
  head:SHA,archive:{name:'sedeagro-images-'+SHA+'.tar',
    sha256:'1'.repeat(64)},images
};
const fileBytes=Buffer.from(JSON.stringify(receipt)+'\n');
const human=()=>({
  status:'HUMAN_SIGNED_OCI_IMAGE_RISK_REVIEW_NOT_DEPLOYED',
  head:SHA,security_owner_risk_accepted:true,
  signer_key_id:'f'.repeat(64),
  oci_archive_sha256:receipt.archive.sha256,
  oci_receipt_sha256:H(fileBytes),
  security_receipt_sha256:'2'.repeat(64),
  production_go:false,staging_certified:false,
  other_owners_approved:false,time_of_use_certified:false,
  images_loaded:false,containers_created:false
});
const verified=()=>({
  status:'OFFLINE_BUNDLE_VERIFIED_NOT_DEPLOYED',
  head:SHA,archive_sha256:receipt.archive.sha256,
  image_ids:{backend:images[0].config_id,frontend:images[1].config_id},
  registry_digest_certified:false,signed_provenance_certified:false
});
const trustedHost=()=>({
  status:'HOST_SIGNED_OCI_IMAGES_PRESENT_READONLY_NOT_DEPLOYED',
  head:SHA,oci_archive_sha256:receipt.archive.sha256,
  oci_receipt_sha256:H(fileBytes),
  security_receipt_sha256:'2'.repeat(64),
  inspected_image_ids:{backend:images[0].config_id,frontend:images[1].config_id},
  local_docker_context:'default',images_loaded_during_check:false,
  containers_created:false,image_pull_allowed:false,build_allowed:false,
  security_owner_approved:false,release_go:false,
  time_of_container_create_certified:false
});
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'sedeagro-oci-host-import-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const ociDir=join(dir,'oci');
  mkdirSync(ociDir,{mode:0o700});
  const bundlePath=join(ociDir,'sedeagro-images-'+SHA+'.tar'),
    receiptPath=join(ociDir,'sedeagro-images-'+SHA+'.json');
  writeFileSync(bundlePath,'FAKE TAR BYTES: verification is injected only in unit tests',
    {mode:0o600});
  writeFileSync(receiptPath,fileBytes,{mode:0o600});
  return {dir,ociDir,bundlePath,receiptPath};
}
function imageData(im,alter={}){
  return {
    Id:im.config_id,Os:'linux',Architecture:'amd64',RepoTags:[im.tag],
    RootFS:{Layers:[...im.layers]},
    Config:{Labels:{'org.opencontainers.image.revision':SHA},
      Env:im.service==='backend'?['SEDEAGRO_BUILD_SHA='+SHA]:[]},
    ...alter
  };
}
function fakeDocker({present=[],mutate,loadFailure=false}={}){
  const tags=new Set(present),calls=[];
  let loads=0;
  return {
    calls,get loads(){return loads;},
    execute(args){
      calls.push(args);
      if(args.join(' ')==='context show')return 'default\n';
      if(args.join(' ')==='context inspect default --format {{json .Endpoints.docker.Host}}')
        return JSON.stringify('unix:///var/run/docker.sock');
      assert.deepEqual(args.slice(0,2),['--context','default'],
        'every image operation uses fixed default Docker context');
      const kind=args[2]+' '+args[3];
      if(kind==='image ls'){
        const reference=args.at(-1).replace('reference=','');
        return tags.has(reference)?id('a')+'\n':'';
      }
      if(kind==='image inspect'){
        const key=args.at(-1);
        const im=images.find(im=>im.config_id===key||im.tag===key);
        if(!im)throw new Error('unexpected Docker image inspect '+key);
        return JSON.stringify(mutate?mutate(imageData(im),key):imageData(im));
      }
      if(kind==='image load'){
        loads++;
        assert.deepEqual(args.slice(4,5),['--input']);
        assert.ok(args.at(-1).endsWith('.tar'));
        if(loadFailure)throw new Error('confidential daemon failure');
        for(const im of images)tags.add(im.tag);
        return 'Loaded image: fake OCI metadata';
      }
      throw new Error('Unexpected mutating Docker operation: '+args.join(' '));
    }
  };
}
function setup(t,opts={}){
  const f=fixture(t);
  const docker=fakeDocker(opts);
  let riskCalls=0,offlineCalls=0,hostCalls=0;
  return {
    ...f,docker,
    options:{
      sha:SHA,evidenceDir:f.dir,mode:opts.mode||'check-only',
      execute:docker.execute,
      verifyRisk:async()=>{riskCalls++;return opts.risk??human();},
      verifyArchive:async()=>{offlineCalls++;return opts.archive??verified();},
      inspectHost:async()=>{hostCalls++;return opts.host??trustedHost();}
    },
    counters:()=>({riskCalls,offlineCalls,hostCalls})
  };
}
test('check-only inspects signed absent images without Docker load, containers or GO',async t=>{
  const f=setup(t),output=await inspectHostSignedOciImport(f.options);
  assert.equal(output.status,'HOST_SIGNED_OCI_IMPORT_CHECKED_NOT_DEPLOYED');
  assert.deepEqual(output.missing_signed_images,['backend','frontend']);
  assert.equal(output.image_load_performed,false);
  assert.equal(output.containers_created,false);
  assert.equal(output.containers_started,false);
  assert.equal(output.production_go,false);
  assert.equal(f.docker.loads,0);
  assert.deepEqual(f.counters(),{riskCalls:1,offlineCalls:1,hostCalls:0});
  assert.ok(f.docker.calls.every(x=>!x.includes('load')));
});

test('import-only verifies same SHA and Docker image IDs after local image-store load',async t=>{
  const f=setup(t,{mode:'import-only'});
  const output=await inspectHostSignedOciImport(f.options);
  assert.equal(output.status,'HOST_SIGNED_OCI_IMAGES_IMPORTED_ONLY_NOT_DEPLOYED');
  assert.deepEqual(output.image_ids,verified().image_ids);
  assert.equal(output.image_load_performed,true);
  assert.equal(output.immutable_ids_not_tags,true);
  assert.equal(output.exact_local_ids_reverified,true);
  assert.equal(output.security_owner_risk_accepted,true);
  for(const field of ['security_owner_deploy_approved','image_pull_allowed',
    'image_build_allowed','containers_created','containers_started',
    'migrations_executed','staging_certified','production_go',
    'production_cutover_tested'])assert.equal(output[field],false,field);
  assert.equal(f.docker.loads,1);
  assert.equal(f.docker.calls.filter(x=>x[2]==='image'&&x[3]==='inspect').length,8);
  assert.deepEqual(f.counters(),{riskCalls:1,offlineCalls:1,hostCalls:1});
  assert.ok(f.docker.calls.every(x=>x[2]!=='container'));
});

test('partial exact images are idempotent but wrong existing tag denies without load',async t=>{
  const partial=setup(t,{mode:'import-only',present:[images[0].tag]});
  const output=await inspectHostSignedOciImport(partial.options);
  assert.deepEqual(output.already_present,{backend:true,frontend:false});
  assert.equal(partial.docker.loads,1);
  const complete=setup(t,{mode:'import-only',present:images.map(im=>im.tag)});
  const kept=await inspectHostSignedOciImport(complete.options);
  assert.equal(kept.image_load_performed,false);
  assert.equal(complete.docker.loads,0);
  const altered=setup(t,{mode:'import-only',present:[images[0].tag],
    mutate:(im,key)=>key===images[0].tag?{...im,Id:id('9')}:im});
  await assert.rejects(inspectHostSignedOciImport(altered.options),
    /OCI_IMPORT_BLOCKED|SIGNED_HOST_OCI_IMPORT_BLOCKED/);
  assert.equal(altered.docker.loads,0);
});

test('missing/forged human Ed25519 review or offline TAR denies before Docker',async t=>{
  for(const edit of [
    {status:'UNSIGNED'}, {head:OTHER},
    {security_owner_risk_accepted:false}, {signer_key_id:'invalid'},
    {oci_archive_sha256:'b'.repeat(64)}, {oci_receipt_sha256:'a'.repeat(64)},
    {security_receipt_sha256:'x'}, {production_go:true},
    {staging_certified:true},{other_owners_approved:true},
    {time_of_use_certified:true},{images_loaded:true},{containers_created:true}
  ]){
    const f=setup(t,{mode:'import-only',risk:{...human(),...edit}});
    await assert.rejects(inspectHostSignedOciImport(f.options),
      /SIGNED_HOST_OCI_IMPORT_BLOCKED/);
    assert.equal(f.docker.calls.length,0);
  }
  for(const edit of [
    {head:OTHER},{archive_sha256:'b'.repeat(64)},
    {image_ids:{backend:id('7'),frontend:images[1].config_id}},
    {signed_provenance_certified:true}
  ]){
    const f=setup(t,{mode:'import-only',archive:{...verified(),...edit}});
    await assert.rejects(inspectHostSignedOciImport(f.options),
      /SIGNED_HOST_OCI_IMPORT_BLOCKED/);
    assert.equal(f.docker.calls.length,0);
  }
});

test('receipt tamper, public directory and symlinked OCI archive block before Docker',async t=>{
  const f=setup(t,{mode:'import-only'});
  writeFileSync(f.receiptPath,JSON.stringify({...receipt,head:OTHER}));
  await assert.rejects(inspectHostSignedOciImport(f.options),
    /SIGNED_HOST_OCI_IMPORT_BLOCKED/);
  assert.equal(f.docker.calls.length,0);
  const g=setup(t,{mode:'import-only'});
  chmodSync(g.ociDir,0o755);
  await assert.rejects(inspectHostSignedOciImport(g.options),
    /SIGNED_HOST_OCI_IMPORT_BLOCKED/);
  assert.equal(g.docker.calls.length,0);
  const h=setup(t,{mode:'import-only'});
  const bad=join(h.ociDir,'other.tar');
  symlinkSync(h.bundlePath,bad);
  rmSync(h.bundlePath);
  symlinkSync(bad,h.bundlePath);
  await assert.rejects(inspectHostSignedOciImport(h.options),
    /SIGNED_HOST_OCI_IMPORT_BLOCKED/);
  assert.equal(h.docker.calls.length,0);
});

test('failed Docker image load and post-load signature drift reject without modifying containers',async t=>{
  const failed=setup(t,{mode:'import-only',loadFailure:true});
  await assert.rejects(inspectHostSignedOciImport(failed.options),
    /SIGNED_HOST_OCI_IMPORT_BLOCKED/);
  assert.equal(failed.docker.loads,1);
  assert.ok(failed.docker.calls.every(x=>x[2]!=='container'));
  for(const changes of [
    {head:OTHER},{oci_archive_sha256:'a'.repeat(64)},
    {oci_receipt_sha256:'b'.repeat(64)},
    {security_receipt_sha256:'c'.repeat(64)},
    {inspected_image_ids:{backend:id('5'),frontend:images[1].config_id}},
    {image_pull_allowed:true},{containers_created:true},{release_go:true}
  ]){
    const g=setup(t,{mode:'import-only',host:{...trustedHost(),...changes}});
    await assert.rejects(inspectHostSignedOciImport(g.options),
      /SIGNED_HOST_OCI_IMPORT_BLOCKED/);
    assert.equal(g.docker.loads,1);
  }
});

test('operator CLI requires local Linux checkout and explicit import-only intent',t=>{
  const f=fixture(t);
  const cli=fileURLToPath(new URL('../import-host-signed-oci-images.mjs',import.meta.url));
  const x=spawnSync(process.execPath,[cli,'--sha',SHA,'--evidence-dir',
    f.dir,'--mode','import-only'],{
    encoding:'utf8',timeout:5000,
    env:{...process.env,SEDEAGRO_OCI_IMPORT_APPROVAL:'NO',
      JWT_SECRET:'DO_NOT_PRINT_SECRET_FROM_HOST'}
  });
  assert.equal(x.status,2,x.stderr);
  assert.match(x.stderr,/BLOCKED signed host OCI import/);
  assert.doesNotMatch(x.stdout+x.stderr,/DO_NOT_PRINT_SECRET_FROM_HOST/);
  for(const e of [
    {DOCKER_HOST:'tcp://remote.invalid:2375'},
    {DOCKER_CONTEXT:'remote'}, {COMPOSE_FILE:'evil.yml'}
  ]){
    const q=spawnSync(process.execPath,[cli,'--sha',SHA,
      '--evidence-dir',f.dir,'--mode','check-only'],{
      encoding:'utf8',timeout:5000,env:{...process.env,...e}
    });
    assert.equal(q.status,2,q.stderr);
    assert.match(q.stderr,/BLOCKED signed host OCI import/);
  }
});

test('host import implementation never mutates containers, migration, proxy or production checkout',()=>{
  const source=readFileSync(
    new URL('../import-host-signed-oci-images.mjs',import.meta.url),'utf8');
  assert.match(source,/inspectSignedImageCandidate/);
  assert.match(source,/verifyReceipt/);
  assert.match(source,/validateLocalDockerContext/);
  assert.match(source,/inspectHostSignedImages/);
  assert.doesNotMatch(source,/docker compose up|docker run|docker build|git pull/);
  assert.doesNotMatch(source,/execFileSync\('sh'/);
  assert.doesNotMatch(source,/image','rm'/);
});
