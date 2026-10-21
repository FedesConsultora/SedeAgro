import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,rmSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rehearseImageImport,validateImportedImage } from '../ci-oci-import-rehearsal.mjs';

const SHA='a'.repeat(40);
const digest=n=>'sha256:'+n.repeat(64);
const services=['backend','frontend'];
const archiveHash='e'.repeat(64);
const images=services.map((service,i)=>({
  service,tag:'sedeagro-'+service+'-rc:'+SHA,
  config_id:digest(i?'b':'c'),os:'linux',architecture:'amd64',
  layers:[digest('d'),digest(i?'1':'2')]
}));
const trusted={status:'OFFLINE_BUNDLE_VERIFIED_NOT_DEPLOYED',
  head:SHA,archive_sha256:archiveHash,
  image_ids:{backend:images[0].config_id,frontend:images[1].config_id},
  registry_digest_certified:false,signed_provenance_certified:false};
const makeInspect=im=>({
  Id:im.config_id,RepoTags:[im.tag],Os:'linux',Architecture:'amd64',
  Config:{Labels:{'org.opencontainers.image.revision':SHA},
    Env:im.service==='backend'?['SEDEAGRO_BUILD_SHA='+SHA]:['PATH=/usr/bin']},
  RootFS:{Layers:im.layers.slice()}
});
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'sedeagro-oci-import-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const receiptPath=join(dir,'receipt.json'),bundlePath=join(dir,'bundle.tar');
  writeFileSync(receiptPath,JSON.stringify({head:SHA,
    archive:{sha256:archiveHash},images}));
  writeFileSync(bundlePath,'synthetic; full archive verification is injected');
  return {bundlePath,receiptPath};
}
function fakeDocker({initiallyPresent=false,importTamper=null,failLoad=false,
  failRemove=false}={}){
  const commands=[],tags=new Set(initiallyPresent?images.map(i=>i.tag):[]);
  let loaded=false;
  function execute(args){
    commands.push(args.slice());
    const [domain,verb]=args;
    assert.equal(domain,'image');
    if(verb==='ls')return tags.has(args[5].slice('reference='.length))?
      'sha256:present\n':'';
    if(verb==='inspect'){
      const im=images.find(i=>i.tag===args[4]);
      if(!im||!tags.has(im.tag))throw Error('image not found');
      const data=makeInspect(im);
      if(loaded&&importTamper==='revision'&&im.service==='backend')
        data.Config.Labels['org.opencontainers.image.revision']='f'.repeat(40);
      if(loaded&&importTamper==='layers'&&im.service==='frontend')
        data.RootFS.Layers=[digest('9')];
      if(loaded&&importTamper==='id'&&im.service==='backend')
        data.Id=digest('9');
      return JSON.stringify(data);
    }
    if(verb==='rm'){
      if(failRemove)throw Error('simulated remove error');
      tags.delete(args[3]);return 'Untagged\n';
    }
    if(verb==='load'){
      if(failLoad)throw Error('simulated load failure');
      loaded=true;for(const im of images)tags.add(im.tag);
      return 'Loaded image\n';
    }
    throw Error('forbidden Docker action '+verb);
  }
  return {execute,commands};
}
const props=(f,d,changes={})=>({
  ...f,sha:SHA,mode:'fresh',execute:d.execute,
  verify:async()=>trusted,...changes
});

test('fresh CI image store imports exact dual tags and fully checks configs and diffIDs',async t=>{
  const f=fixture(t),d=fakeDocker();
  const result=await rehearseImageImport(props(f,d));
  assert.equal(result.status,'CI_OCI_IMPORT_REHEARSAL_VERIFIED_NOT_DEPLOYED');
  assert.equal(result.independent_runner,true);
  assert.deepEqual(result.imported_images,trusted.image_ids);
  assert.equal(result.registry_digest_certified,false);
  assert.deepEqual(d.commands.map(x=>x[1]),
    ['ls','ls','load','ls','inspect','ls','inspect']);
  assert.deepEqual(d.commands.find(x=>x[1]==='load'),
    ['image','load','--input',f.bundlePath]);
  assert.ok(!d.commands.some(x=>['run','exec','start','push','pull'].includes(x[1])));
});
test('fresh runner with release tag present refuses import',async t=>{
  const f=fixture(t),d=fakeDocker({initiallyPresent:true});
  await assert.rejects(rehearseImageImport(props(f,d)),/fresh runner already/);
  assert.deepEqual(d.commands.map(x=>x[1]),['ls']);
});
test('producer first proves built images, removes exact tags, then reloads verified archive',async t=>{
  const f=fixture(t),d=fakeDocker({initiallyPresent:true});
  const result=await rehearseImageImport(props(f,d,{mode:'replace'}));
  assert.equal(result.independent_runner,false);
  assert.deepEqual(d.commands.map(x=>x[1]),[
    'ls','inspect','ls','inspect','rm','rm','ls','ls','load','ls','inspect','ls','inspect'
  ]);
  assert.deepEqual(d.commands.filter(x=>x[1]==='rm').map(x=>x.slice(2)),
    images.map(im=>['--no-prune',im.tag]));
});
test('invalid archive receipt never calls Docker',async t=>{
  const f=fixture(t),d=fakeDocker();
  for(const verify of [
    async()=>({...trusted,archive_sha256:'wrong'}),
    async()=>{throw Error('archive SHA mismatch');},
    async()=>({...trusted,head:'f'.repeat(40)})
  ]){
    await assert.rejects(rehearseImageImport(props(f,d,{verify})));
  }
  assert.equal(d.commands.length,0);
});
test('source image config mismatch blocks deletion and load',async t=>{
  const f=fixture(t),d=fakeDocker({initiallyPresent:true});
  const real=d.execute;
  d.execute=args=>{
    const v=real(args);
    if(args[1]==='inspect'){const j=JSON.parse(v);j.Id=digest('f');return JSON.stringify(j);}
    return v;
  };
  await assert.rejects(rehearseImageImport(props(f,d,{mode:'replace'})),
    /Docker image config/);
  assert.ok(!d.commands.some(x=>['rm','load'].includes(x[1])));
});
test('Docker load failure or altered imported SHA, rootfs or image ID never passes',async t=>{
  for(const option of [{failLoad:true},{importTamper:'revision'},
    {importTamper:'layers'},{importTamper:'id'}]){
    const f=fixture(t),d=fakeDocker(option);
    await assert.rejects(rehearseImageImport(props(f,d)));
    assert.equal(d.commands.filter(x=>x[1]==='load').length,1);
  }
});
test('failure to delete source image blocks import',async t=>{
  const f=fixture(t),d=fakeDocker({initiallyPresent:true,failRemove:true});
  await assert.rejects(rehearseImageImport(props(f,d,{mode:'replace'})),/remove error/);
  assert.equal(d.commands.filter(x=>x[1]==='load').length,0);
});
test('runtime OCI identity rejects platform, label, layer, tags and backend SHA tampering',()=>{
  const orig=makeInspect(images[0]);
  assert.equal(validateImportedImage(orig,images[0],SHA),images[0].config_id);
  for(const bad of [
    {...orig,RepoTags:[]},{...orig,Os:'windows'},
    {...orig,Config:{...orig.Config,Env:[]}},
    {...orig,Config:{...orig.Config,Labels:{}}},
    {...orig,RootFS:{Layers:[digest('9')]}},
  ])assert.throws(()=>validateImportedImage(bad,images[0],SHA),
    /OCI_IMPORT_BLOCKED/);
});
test('CLI rejects invocation outside exact GitHub CI and suppresses private data',()=>{
  const cli=fileURLToPath(new URL('../ci-oci-import-rehearsal.mjs',import.meta.url));
  const p=spawnSync(process.execPath,[cli,'--mode','fresh','--sha',SHA,
    '--bundle','/tmp/foreign.tar','--receipt','/tmp/foreign.json'],{
    encoding:'utf8',timeout:6000,
    env:{...process.env,CI:'false',GITHUB_ACTIONS:'false',IMAGE_SHA:SHA,
      JWT_SECRET:'NEVER_LOG_PRIVATE_KEY'}
  });
  assert.equal(p.status,2);
  assert.match(p.stderr,/BLOCKED CI OCI import/);
  assert.doesNotMatch(p.stdout+p.stderr,/NEVER_LOG_PRIVATE_KEY/);
});
test('workflow does producer replay and separate main-only fresh runner download',()=>{
  const workflow=readFileSync(new URL('../../.github/workflows/postgres-isolation.yml',import.meta.url),'utf8');
  const prod=workflow.split('  production-images:')[1]?.split('  dependency-security:')[0]||'';
  const fresh=workflow.split('  offline-image-import:')[1]||'';
  assert.match(prod,/ci-oci-import-rehearsal\.mjs --mode replace/);
  assert.match(prod,/oci-release-bundle\.mjs verify/);
  assert.match(prod,/github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
  assert.match(fresh,/needs: production-images/);
  assert.match(fresh,/github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
  assert.match(fresh,/actions\/download-artifact@v4/);
  assert.match(fresh,/ci-oci-import-rehearsal\.mjs --mode fresh/);
  assert.match(fresh,/oci-release-bundle\.mjs verify/);
  assert.doesNotMatch(fresh,/(?:docker\s+(?:push|pull|run|start|compose up))/);
});
