import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {
  rehearseImmutableContainerCreate,validateCreatedContainer
} from '../ci-oci-container-creation.mjs';

const SHA='a'.repeat(40),OTHER='f'.repeat(40);
const ID=x=>'sha256:'+x.repeat(64);
const CID=x=>x.repeat(64);
const images=['backend','frontend'].map((service,i)=>({
  service,tag:'sedeagro-'+service+'-rc:'+SHA,
  config_id:ID(i?'b':'c')
}));
const receipt={head:SHA,
  archive:{name:'sedeagro-images-'+SHA+'.tar',sha256:'d'.repeat(64)},images};
const verified={
  status:'CI_OCI_PRODUCTION_TOPOLOGY_OVERLAY_VALIDATED_NOT_DEPLOYED',
  head:SHA,archive_sha256:'d'.repeat(64),
  imported_images:{backend:images[0].config_id,frontend:images[1].config_id},
  container_started:false,production_deploy_certified:false,
  time_of_use_certified:false,security_owner_approved:false,secrets_loaded:false
};
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'sedeagro-immutable-create-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const receiptPath=join(dir,'sedeagro-images-'+SHA+'.json');
  const bundlePath=join(dir,'sedeagro-images-'+SHA+'.tar');
  writeFileSync(receiptPath,JSON.stringify(receipt));
  writeFileSync(bundlePath,'synthetic, verified predecessor mocked');
  return {receiptPath,bundlePath};
}
function asContainer(im,name,cid){
  return {
    Id:cid,Name:'/'+name,Image:im.config_id,
    Config:{Image:im.config_id,Entrypoint:[im.service==='backend'?'node':'nginx'],
      Cmd:[im.service==='backend'?'--version':'-v']},
    State:{Status:'created',Running:false,StartedAt:'0001-01-01T00:00:00Z'},
    HostConfig:{NetworkMode:'none',ReadonlyRootfs:true,
      Privileged:false,AutoRemove:false,PortBindings:{}},
    Mounts:[]
  };
}
function fakeDocker({mutate=null,throwAt=null}={}){
  const calls=[],names=new Map();
  const execute=args=>{
    calls.push(args.slice());
    const action=args[0]+' '+args[1];
    if(throwAt==='create'&&action==='container create')throw Error('daemon create unavailable');
    if(action==='container create'){
      assert.ok(args.includes('--pull=never'));
      assert.ok(args.includes('--network=none'));
      assert.ok(args.includes('--read-only'));
      const name=args[args.indexOf('--name')+1],
        im=images.find(x=>x.config_id===args[args.indexOf('--entrypoint')+2]);
      assert.ok(im,'container was not created with an expected image config ID');
      const cid=CID(im.service==='backend'?'1':'2');
      names.set(name,{im,cid});
      return cid+'\n';
    }
    if(action==='container inspect'){
      const match=[...names.entries()].find(([,x])=>x.cid===args[args.length-1]);
      if(!match)throw Error('missing container');
      const [name,{im,cid}]=match;
      const value=asContainer(im,name,cid);
      if(mutate)mutate(value,im);
      return JSON.stringify(value);
    }
    if(action==='container rm'){
      if(throwAt==='rm')throw Error('cleanup denied');
      assert.ok(args.includes('--force')&&args.includes('--volumes'));
      const name=args[args.length-1];
      assert.ok(names.has(name));
      names.delete(name);
      return name+'\n';
    }
    if(action==='container ls'){
      if(throwAt==='ls')throw Error('daemon down after cleanup');
      return '';
    }
    throw Error('unexpected docker command '+args.join(' '));
  };
  return {execute,calls,names};
}
function props(f,d,extra={}){
  return {...f,sha:SHA,preview:async()=>verified,execute:d.execute,
    nameSuffix:()=> '0'.repeat(12),...extra};
}

test('two stopped containers created from immutable signed config IDs, inspected and removed',async t=>{
  const f=fixture(t),d=fakeDocker();
  const output=await rehearseImmutableContainerCreate(props(f,d));
  assert.equal(output.status,
    'CI_OCI_STOPPED_CONTAINER_CREATION_IMAGE_IDS_VERIFIED_NOT_DEPLOYED');
  assert.deepEqual(output.created_image_ids,verified.imported_images);
  assert.equal(output.verified_by_immutable_id,true);
  assert.equal(output.used_image_tags_for_creation,false);
  assert.equal(output.image_pull_allowed,false);
  assert.equal(output.container_started,false);
  assert.equal(output.network_created,false);
  assert.equal(output.all_disposable_containers_removed,true);
  assert.equal(output.production_deploy_certified,false);
  assert.equal(output.production_race_lock_certified,false);
  assert.equal(output.security_owner_approved,false);
  assert.equal(d.names.size,0);
  assert.deepEqual(d.calls.map(x=>x.slice(0,2).join(' ')),[
    'container create','container inspect','container rm','container ls',
    'container create','container inspect','container rm','container ls']);
  assert.ok(d.calls.every(x=>!['run','start','pull','build','up','load'].includes(x[1])));
  assert.equal(d.calls.filter(x=>x[1]==='create').every(x=>
    x.some(v=>v===images[0].config_id||v===images[1].config_id)&&
    !x.some(v=>v.includes('-rc:'+SHA))),true);
});

test('attacker retagging mutable SHA label cannot affect image selection by immutable ID',async t=>{
  const f=fixture(t),d=fakeDocker();
  const r=await rehearseImmutableContainerCreate(props(f,d));
  assert.deepEqual(r.created_image_ids,verified.imported_images);
  const created=d.calls.filter(a=>a[1]==='create');
  assert.equal(created.length,2);
  for(const call of created){
    assert.ok(call.includes(images[0].config_id)||call.includes(images[1].config_id));
    assert.ok(!call.some(x=>x.startsWith('sedeagro-backend-rc:')||
      x.startsWith('sedeagro-frontend-rc:')));
  }
});

test('wrong config, unexpected running or networked container causes hard failure and removal',async t=>{
  const f=fixture(t);
  const mutants=[
    x=>{x.Image=ID('f');},
    x=>{x.Config.Image=ID('f');},
    x=>{x.State.Status='running';x.State.Running=true;},
    x=>{x.State.StartedAt='2026-10-22T00:00:00Z';},
    x=>{x.HostConfig.NetworkMode='host';},
    x=>{x.HostConfig.ReadonlyRootfs=false;},
    x=>{x.HostConfig.Privileged=true;},
    x=>{x.HostConfig.PortBindings={'80/tcp':[{'HostPort':'1234'}]};},
    x=>{x.Mounts=[{Source:'/secrets',Destination:'/mnt'}];},
    x=>{x.Config.Image='sedeagro-backend-rc:'+SHA;},
    x=>{x.Name='/other';},
    x=>{x.Config.Entrypoint=['sh'];},
    x=>{x.Config.Cmd=['-c','malicious'];}
  ];
  for(const mutate of mutants){
    const d=fakeDocker({mutate});
    await assert.rejects(rehearseImmutableContainerCreate(props(f,d)),
      /IMMUTABLE_CONTAINER_CREATE_BLOCKED/);
    assert.equal(d.names.size,0);
    assert.ok(d.calls.some(x=>x[1]==='rm'));
    assert.ok(d.calls.every(x=>x[1]!=='start'));
  }
});

test('receipt tampering and fake predecessor never reach Docker create',async t=>{
  const f=fixture(t),d=fakeDocker();
  for(const invalid of [
    {...verified,head:OTHER},
    {...verified,archive_sha256:'f'.repeat(64)},
    {...verified,production_deploy_certified:true},
    {...verified,container_started:true},
    {...verified,security_owner_approved:true},
    {...verified,secrets_loaded:true},
    {...verified,imported_images:{backend:ID('f'),frontend:ID('e')}}
  ]){
    await assert.rejects(rehearseImmutableContainerCreate(props(f,d,{
      preview:async()=>invalid
    })),/IMMUTABLE_CONTAINER_CREATE_BLOCKED/);
  }
  for(const edit of [
    r=>{r.head=OTHER;},
    r=>{r.archive.sha256='f'.repeat(64);},
    r=>{r.images=[r.images[0],r.images[0]];},
    r=>{r.images[1].config_id=ID('f');},
    r=>{r.images[1].tag='nginx:latest';}
  ]){
    const mutated=structuredClone(receipt);
    edit(mutated);
    writeFileSync(f.receiptPath,JSON.stringify(mutated));
    await assert.rejects(rehearseImmutableContainerCreate(props(f,d)),
      /IMMUTABLE_CONTAINER_CREATE_BLOCKED/);
  }
  assert.equal(d.calls.length,0);
});

test('invalid CID and Docker create errors trigger cleanup or fail closed',async t=>{
  const f=fixture(t);
  const broken=fakeDocker();
  const execute=args=>{
    if(args[1]==='create'){broken.calls.push(args);return 'not-a-container-id';}
    return broken.execute(args);
  };
  // Since daemon did not create a container, clean-up fails: must still deny.
  await assert.rejects(rehearseImmutableContainerCreate(props(f,broken,{execute})),
    /IMMUTABLE_CONTAINER_CREATE_BLOCKED/);
  const failed=fakeDocker({throwAt:'create'});
  await assert.rejects(rehearseImmutableContainerCreate(props(f,failed)),
    /IMMUTABLE_CONTAINER_CREATE_BLOCKED/);
  const cleanup=fakeDocker({throwAt:'rm'});
  await assert.rejects(rehearseImmutableContainerCreate(props(f,cleanup)),
    /cleanup failed/);
  const cleanupVerify=fakeDocker({throwAt:'ls'});
  await assert.rejects(rehearseImmutableContainerCreate(props(f,cleanupVerify)),
    /cleanup failed/);
});

test('missing or short-circuit invalid name suffix denies before create',async t=>{
  const f=fixture(t),d=fakeDocker();
  await assert.rejects(rehearseImmutableContainerCreate(props(f,d,{
    nameSuffix:()=> '../bad'
  })),/IMMUTABLE_CONTAINER_CREATE_BLOCKED/);
  assert.equal(d.calls.length,0);
});

test('CLI outside exact GitHub push/main blocks before invoking Docker or printing secrets',t=>{
  const f=fixture(t);
  const cli=fileURLToPath(new URL('../ci-oci-container-creation.mjs',import.meta.url));
  const r=spawnSync(process.execPath,[cli,'--sha',SHA,'--bundle',
    f.bundlePath,'--receipt',f.receiptPath],{
    encoding:'utf8',timeout:6000,
    env:{...process.env,CI:'false',GITHUB_ACTIONS:'false',
      GH_TOKEN:'DO_NOT_LEAK',JWT_SECRET:'DO_NOT_LEAK'}
  });
  assert.equal(r.status,2);
  assert.match(r.stderr,/BLOCKED OCI container creation/);
  assert.doesNotMatch(r.stderr+r.stdout,/DO_NOT_LEAK/);
});

test('workflow orders proof strictly after signatures and import; deploy remains hardstop',()=>{
  const wf=readFileSync(new URL('../../.github/workflows/postgres-isolation.yml',import.meta.url),'utf8');
  const receiver=wf.split('  offline-image-import:')[1]||'';
  const a=receiver.indexOf('verify-oci-signed-provenance.mjs --sha'),
    b=receiver.indexOf('verify-image-security.mjs --mode verify-signed'),
    c=receiver.indexOf('ci-oci-import-rehearsal.mjs --mode fresh'),
    d=receiver.indexOf('ci-oci-production-overlay.mjs --sha'),
    e=receiver.indexOf('ci-oci-container-creation.mjs --sha');
  assert.ok(a>=0&&b>a&&c>b&&d>c&&e>d);
  assert.doesNotMatch(receiver,/docker (?:run|container start|compose up|compose build)\b/);
  const deploy=readFileSync(new URL('../../scripts/deploy-prod.sh',import.meta.url),'utf8');
  const admission=readFileSync(new URL('../../scripts/verify-production-image-admission.mjs',import.meta.url),'utf8');
  assert.match(deploy,/docker compose build backend frontend/);
  assert.match(admission,/deploy-prod.sh rebuilds Docker images/);
});
