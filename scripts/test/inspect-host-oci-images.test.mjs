import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {chmodSync,mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync}
  from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectHostSignedImages,validateSignedHostImagePair}
  from '../inspect-host-oci-images.mjs';

const SHA='a'.repeat(40),OTHER='f'.repeat(40);
const H=b=>createHash('sha256').update(b).digest('hex');
const image=(service,id,layer)=>({
  service,tag:'sedeagro-'+service+'-rc:'+SHA,
  config_id:'sha256:'+id.repeat(64),os:'linux',architecture:'amd64',
  layers:['sha256:'+layer.repeat(64)]
});
const images=[image('backend','b','c'),image('frontend','d','e')];
const receipt={
  head:SHA,archive:{name:'sedeagro-images-'+SHA+'.tar',
    sha256:'1'.repeat(64)},images
};
const bytes=Buffer.from(JSON.stringify(receipt)+'\n');
const oci={
  status:'GITHUB_SIGNED_OCI_ARTIFACTS_VERIFIED_NOT_DEPLOYED',
  head:SHA,repository:'FedesConsultora/SedeAgro',
  source_ref:'refs/heads/main',
  signer_workflow:'FedesConsultora/SedeAgro/.github/workflows/postgres-isolation.yml',
  github_oidc_signature_checked:true,
  subjects:[
    {name:'sedeagro-images-'+SHA+'.tar',sha256:receipt.archive.sha256},
    {name:'sedeagro-images-'+SHA+'.json',sha256:H(bytes)}
  ]
};
const security={
  status:'GITHUB_SIGNED_IMAGE_SECURITY_VERIFIED_RELEASE_NOT_CERTIFIED',
  head:SHA,source_signed:true,images_verified:2,
  subjects:[
    'sedeagro-backend-'+SHA+'.spdx.json',
    'sedeagro-backend-'+SHA+'.trivy.json',
    'sedeagro-frontend-'+SHA+'.spdx.json',
    'sedeagro-frontend-'+SHA+'.trivy.json',
    'sedeagro-security-'+SHA+'.json'
  ].map((name,i)=>({name,sha256:String(i).repeat(64)})),
  review:{findings:3,
    severities:{CRITICAL:0,HIGH:0,MEDIUM:1,LOW:0,UNKNOWN:2},
    high_critical_findings:0,release_go:false,
    release_gate:'EXTERNAL_SECURITY_REVIEW_REQUIRED',
    security_owner_review_required:true
  }
};
function fixture(t){
  const base=mkdtempSync(join(tmpdir(),'sedeagro-host-oci-'));
  t.after(()=>rmSync(base,{recursive:true,force:true}));
  const ociDir=join(base,'oci'),secDir=join(base,'security');
  mkdirSync(ociDir,{mode:0o700});mkdirSync(secDir,{mode:0o700});
  writeFileSync(join(ociDir,'sedeagro-images-'+SHA+'.json'),bytes,{mode:0o600});
  return {base,ociDir,secDir};
}
function dockerImage(im){
  return {Id:im.config_id,Os:'linux',Architecture:'amd64',
    RepoTags:[im.tag],Config:{
      Labels:{'org.opencontainers.image.revision':SHA},
      Env:im.service==='backend'?['SEDEAGRO_BUILD_SHA='+SHA]:[]
    },RootFS:{Layers:im.layers}};
}
function fakeDocker({mutate=null,endpoint='unix:///var/run/docker.sock',
  context='default'}={}){
  const calls=[],items=new Map(images.flatMap(im=>[
    [im.tag,dockerImage(im)],[im.config_id,dockerImage(im)]
  ]));
  let inspectCount=0;
  return {
    calls,
    execute(args){
      calls.push(args);
      if(args.join(' ')==='context show')return context+'\n';
      if(args.join(' ')==='context inspect default --format {{json .Endpoints.docker.Host}}')
        return JSON.stringify(endpoint)+'\n';
      assert.deepEqual(args.slice(0,6),[
        '--context','default','image','inspect','--format','{{json .}}'
      ]);
      const ref=args[6],original=items.get(ref);
      if(!original)throw new Error('missing image in local store');
      inspectCount++;
      const clone=structuredClone(original);
      if(mutate)mutate(clone,{ref,inspectCount});
      return JSON.stringify(clone);
    }
  };
}
async function attempt(t,opts={}){
  const {base}=fixture(t),d=opts.docker||fakeDocker();
  let ociCalls=0,scannerCalls=0;
  const result=inspectHostSignedImages({
    sha:SHA,evidenceDir:base,execute:d.execute,
    verifyOci:async()=>{ociCalls++;return opts.oci||oci;},
    verifySecurity:async()=>{scannerCalls++;return opts.security||security;}
  });
  return {result,calls:d.calls,proofCounts:()=>[ociCalls,scannerCalls],base};
}

test('seven signed inputs precede read-only immutable ID/tag inspections; never GO',async t=>{
  const a=await attempt(t),result=await a.result;
  assert.equal(result.status,'HOST_SIGNED_OCI_IMAGES_PRESENT_READONLY_NOT_DEPLOYED');
  assert.equal(result.head,SHA);
  assert.deepEqual(result.inspected_image_ids,
    {backend:images[0].config_id,frontend:images[1].config_id});
  assert.equal(result.security_owner_approved,false);
  assert.equal(result.release_go,false);
  assert.equal(result.time_of_container_create_certified,false);
  assert.equal(result.production_deploy_certified,false);
  assert.deepEqual(a.proofCounts(),[1,1]);
  assert.equal(a.calls.length,10);
  assert.equal(a.calls.filter(c=>c.includes('image')).length,8);
  for(const args of a.calls){
    assert.ok(args[0]==='context'||args[0]==='--context');
    assert.ok(!args.some(x=>['load','create','run','up','start','build','pull'].includes(x)));
  }
});

test('missing or malformed signed OCI/scanner context denies BEFORE Docker access',async t=>{
  for(const update of [
    {oci:{...oci,github_oidc_signature_checked:false}},
    {oci:{...oci,source_ref:'refs/heads/other'}},
    {oci:{...oci,subjects:oci.subjects.slice(0,1)}},
    {security:{...security,source_signed:false}},
    {security:{...security,subjects:security.subjects.slice(0,4)}},
    {security:{...security,head:OTHER}},
    {security:{...security,review:{...security.review,release_go:true}}},
    {security:{...security,review:{...security.review,
      severities:{...security.review.severities,HIGH:1}}}}
  ]){
    const a=await attempt(t,update);
    await assert.rejects(a.result,/SECURITY_OWNER_APPROVAL_BLOCKED/);
    assert.equal(a.calls.length,0);
  }
});

test('local context must target default Unix socket, never SSH/TCP/remote',async t=>{
  for(const invalid of [
    {context:'remote-cluster'},
    {endpoint:'tcp://127.0.0.1:2376'},
    {endpoint:'ssh://some-host'},
    {endpoint:'unix:///tmp/other-docker.sock'}
  ]){
    const d=fakeDocker(invalid),a=await attempt(t,{docker:d});
    await assert.rejects(a.result,/HOST_OCI_READONLY_BLOCKED/);
    assert.equal(d.calls.some(x=>x.includes('image')),false);
  }
});

test('wrong config IDs, tag reassignment, layer mutation and SHA labels deny',async t=>{
  for(const mutate of [
    (im,{ref})=>{if(ref===images[0].tag)im.Id='sha256'+'f'.repeat(64);},
    (im,{ref})=>{if(ref===images[1].config_id)im.RootFS.Layers=[];},
    (im,{ref})=>{if(ref===images[1].tag)im.Config.Labels['org.opencontainers.image.revision']=OTHER;},
    (im,{ref})=>{if(ref===images[0].tag)im.RepoTags=[];},
    (im,{ref})=>{if(ref===images[0].config_id)im.Architecture='arm64';},
    (im,{ref,inspectCount})=>{if(ref===images[0].tag&&inspectCount>=6)
      im.Id='sha256:'+'f'.repeat(64);}
  ]){
    const a=await attempt(t,{docker:fakeDocker({mutate})});
    await assert.rejects(a.result,/OCI_IMPORT_BLOCKED|HOST_OCI_READONLY_BLOCKED/);
  }
});

test('unavailable imported config denies without image load, pull or create',async t=>{
  const d=fakeDocker();
  const original=d.execute.bind(d);
  d.execute=args=>{
    if(args[0]==='--context'&&args.at(-1)===images[0].config_id)
      throw new Error('missing local imported Docker image');
    return original(args);
  };
  const a=await attempt(t,{docker:d});
  await assert.rejects(a.result,/missing local imported Docker image/);
  assert.equal(d.calls.some(args=>args.includes('load')),false);
});

test('symlink evidence directory and loose permissions block ahead of attestation',async t=>{
  const {base,ociDir}=fixture(t),calls=[];
  chmodSync(ociDir,0o755);
  await assert.rejects(inspectHostSignedImages({
    sha:SHA,evidenceDir:base,
    verifyOci:()=>{calls.push('attested');return oci;}
  }),/HOST_OCI_READONLY_BLOCKED/);
  chmodSync(ociDir,0o700);
  const symlink=join(base,'link');
  symlinkSync(ociDir,symlink);
  await assert.rejects(inspectHostSignedImages({
    sha:SHA,evidenceDir:symlink,
    verifyOci:()=>{calls.push('attested');return oci;}
  }),/HOST_OCI_READONLY_BLOCKED/);
  assert.deepEqual(calls,[]);
});

test('CLI rejects invalid SHA and forged environment without invoking Docker',()=>{
  const cli=fileURLToPath(new URL('../inspect-host-oci-images.mjs',import.meta.url));
  for(const env of [
    {...process.env,DOCKER_HOST:'tcp://remote.example:2375'},
    {...process.env,DOCKER_CONTEXT:'remote'}
  ]){
    const result=spawnSync(process.execPath,[cli,'--sha',SHA,
      '--evidence-dir','/tmp/never-allow-this'],{
      encoding:'utf8',timeout:8000,env
    });
    assert.equal(result.status,2);
    assert.match(result.stderr,/BLOCKED read-only host OCI inspection/);
    assert.doesNotMatch(result.stdout,/PRESENT|APPROVED|DEPLOYED/);
  }
  const result=spawnSync(process.execPath,[cli,'--sha','bad',
    '--evidence-dir','/tmp/nowhere'],{encoding:'utf8',timeout:8000});
  assert.equal(result.status,2);
});

test('source contains no image/container creation or ability to skip signature verification',()=>{
  const source=readFileSync(new URL('../inspect-host-oci-images.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(source,/execute\(\s*\[\s*['"](?:load|run|start|pull|build|create|up)['"]/);
  assert.match(source,/verifyOci\(\{sha,bundlePath,receiptPath\}\)/);
  assert.match(source,/verifySecurity\(\{sha,dir:securityDir,ociReceiptPath:receiptPath\}\)/);
});
