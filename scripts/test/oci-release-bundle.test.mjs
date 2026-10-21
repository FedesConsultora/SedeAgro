import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync, chmodSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeReceipt, createCIReceipt, inspectDockerSaveTar, verifyReceipt
} from '../oci-release-bundle.mjs';

const SHA = 'a'.repeat(40);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const root = fileURLToPath(new URL('../../', import.meta.url));
const cli = fileURLToPath(new URL('../oci-release-bundle.mjs', import.meta.url));
const oct = (number, length) => number.toString(8).padStart(length - 1, '0') + '\0';
function header(name, size, type = '0') {
  const buffer = Buffer.alloc(512);
  Buffer.from(name).copy(buffer, 0);
  Buffer.from(oct(0o644, 8)).copy(buffer, 100);
  Buffer.from(oct(0, 8)).copy(buffer, 108);
  Buffer.from(oct(0, 8)).copy(buffer, 116);
  Buffer.from(oct(size, 12)).copy(buffer, 124);
  Buffer.from(oct(0, 12)).copy(buffer, 136);
  buffer.fill(32, 148, 156);
  buffer.write(type, 156, 1);
  buffer.write('ustar\0', 257, 6);
  buffer.write('00', 263, 2);
  const checksum = buffer.reduce((sum, byte) => sum + byte, 0);
  Buffer.from(checksum.toString(8).padStart(6, '0') + '\0 ', 'ascii')
    .copy(buffer, 148);
  return buffer;
}
function tar(members) {
  const chunks = [];
  for (const item of members) {
    const data = Buffer.isBuffer(item.data) ? item.data :
      Buffer.from(item.data ?? '', 'utf8');
    chunks.push(header(item.name, data.length, item.type ?? '0'));
    if (data.length) chunks.push(data);
    if (data.length % 512) chunks.push(Buffer.alloc(512 - (data.length % 512)));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}
function synthetic({revision=SHA,wrongLayer=false,extra=[],duplicate=false,
  extraTag=false,missingLayer=false,ociIndex=false,badOCIReference=false}={}) {
  const files=[];
  const images=[];
  const ociDescriptors=[];
  const ids={};
  const layers={};
  for (const service of ['backend', 'frontend']) {
    const layer = Buffer.from(service + ':synthetic uncompressed rootfs bytes');
    const layerDigest=hash(layer);
    const filename='blobs/sha256/' + layerDigest;
    const tags = ['sedeagro-' + service + '-rc:' + SHA];
    if (extraTag && service==='frontend') tags.push('latest');
    const config={
      architecture:'amd64',os:'linux',
      config:{
        Labels:{'org.opencontainers.image.revision':revision},
        Env:service==='backend'?['SEDEAGRO_BUILD_SHA='+SHA]:['PATH=/usr/bin']
      },
      rootfs:{type:'layers',diff_ids:['sha256:'+layerDigest]}
    };
    const configBuffer=Buffer.from(JSON.stringify(config));
    const configId='sha256:'+hash(configBuffer);
    const configName='blobs/sha256/'+configId.slice(7);
    const manifest={
      Config:configName,RepoTags:tags,
      Layers:missingLayer&&service==='frontend'?['not-found-layer.tar']:[filename]
    };
    files.push({name:configName,data:configBuffer});
    files.push({name:filename,data:
      wrongLayer&&service==='backend'?Buffer.from('tampered uncompressed rootfs data'):layer});
    if (ociIndex) {
      const imageManifest={
        schemaVersion:2,
        config:{mediaType:'application/vnd.oci.image.config.v1+json',
          digest:configId,size:configBuffer.length},
        layers:[{
          mediaType:'application/vnd.oci.image.layer.v1.tar',
          digest:badOCIReference&&service==='backend'?
            'sha256:'+'c'.repeat(64):'sha256:'+layerDigest,
          size:layer.length
        }]
      };
      const data=Buffer.from(JSON.stringify(imageManifest));
      const id=hash(data);
      files.push({name:'blobs/sha256/'+id,data});
      ociDescriptors.push({
        mediaType:'application/vnd.oci.image.manifest.v1+json',
        digest:'sha256:'+id,size:data.length
      });
    }
    images.push(manifest);
    ids[service]=configId;
    layers[service]=['sha256:'+layerDigest];
  }
  if (ociIndex) {
    files.push({name:'index.json',data:JSON.stringify({
      schemaVersion:2,manifests:ociDescriptors
    })});
    files.push({name:'oci-layout',data:JSON.stringify({imageLayoutVersion:'1.0.0'})});
  }
  if (duplicate)files.push({...files[0]});
  files.push(...extra);
  files.push({name:'manifest.json',data:JSON.stringify(images)});
  files.push({name:'repositories',data:JSON.stringify({})});
  return {contents:tar(files),ids,layers};
}
function fixture(t, options={}) {
  const directory=mkdtempSync(join(tmpdir(),'sedeagro-oci-0p25-'));
  t.after(()=>rmSync(directory,{force:true,recursive:true}));
  const bundlePath=join(directory,'sedeagro-images-'+SHA+'.tar');
  const receiptPath=join(directory,'sedeagro-images-'+SHA+'.json');
  const result=synthetic(options);
  writeFileSync(bundlePath,result.contents,{mode:0o600});
  return {...result,bundlePath,receiptPath,directory};
}
const dockerIdentity = (fixture, service) => ({
  Id:fixture.ids[service],Os:'linux',Architecture:'amd64',
  Config:{Labels:{'org.opencontainers.image.revision':SHA}},
  RootFS:{Layers:fixture.layers[service]}
});
async function validReceipt(t){
  const f=fixture(t);
  const expected=await createCIReceipt({
    bundlePath:f.bundlePath,receiptPath:f.receiptPath,sha:SHA,
    imageInspect:tag=>dockerIdentity(f,tag.startsWith('sedeagro-backend')?'backend':'frontend')
  });
  return {f,expected};
}

test('creates receipt only when two Docker image configs, layers, tags and SHA match',async t=>{
  const {f,expected}=await validReceipt(t);
  assert.equal(expected.status,'OFFLINE_BUNDLE_VERIFIED_NOT_DEPLOYED');
  assert.equal(expected.head,SHA);
  assert.equal(expected.image_ids.backend,f.ids.backend);
  assert.equal(expected.image_ids.frontend,f.ids.frontend);
  assert.match(expected.archive_sha256,/^[a-f0-9]{64}$/);
  const saved=JSON.parse(readFileSync(f.receiptPath,'utf8'));
  assert.equal(saved.images.length,2);
  assert.deepEqual(saved.images.map(x=>x.service),['backend','frontend']);
  assert.equal(saved.registry_digest_certified,false);
  assert.equal(saved.signed_provenance_certified,false);
  assert.equal(saved.staging_deployment_certified,false);
  assert.equal(saved.archive.name,'sedeagro-images-'+SHA+'.tar');
  assert.equal((await verifyReceipt({
    bundlePath:f.bundlePath,receiptPath:f.receiptPath,sha:SHA
  })).archive_sha256,expected.archive_sha256);
});

test('supports modern Docker-save legacy manifest plus authenticated OCI index/blob descriptors',async t=>{
  const f=fixture(t,{ociIndex:true});
  const receipt=await computeReceipt({bundlePath:f.bundlePath,sha:SHA});
  assert.equal(receipt.images.length,2);
  assert.deepEqual(receipt.images.map(im=>im.config_id),
    [f.ids.backend,f.ids.frontend]);
});
test('rejects OCI image manifest with a broken layer descriptor digest',async t=>{
  const f=fixture(t,{ociIndex:true,badOCIReference:true});
  await assert.rejects(computeReceipt({bundlePath:f.bundlePath,sha:SHA}),
    /OCI blob digest or size mismatch/);
});
test('rejects detached OCI metadata blobs that are not reachable from the index',async t=>{
  const extraContent='extra metadata';
  const f=fixture(t,{ociIndex:true,extra:[{
    name:'blobs/sha256/'+hash(Buffer.from(extraContent)),data:extraContent
  }]});
  await assert.rejects(computeReceipt({bundlePath:f.bundlePath,sha:SHA}),
    /unreferenced OCI binary-layer blob/);
});

test('offline CLI validates downloaded bytes without CI/Docker or network',async t=>{
  const {f}=await validReceipt(t);
  const proc=spawnSync(process.execPath,[cli,'verify','--sha',SHA,
    '--bundle',f.bundlePath,'--receipt',f.receiptPath],{
    encoding:'utf8',timeout:10000,
    env:{...process.env,CI:'false',GITHUB_ACTIONS:'false',
      IMAGE_SHA:'c'.repeat(40)}
  });
  assert.equal(proc.status,0,proc.stderr);
  assert.match(proc.stdout,/OFFLINE_BUNDLE_VERIFIED_NOT_DEPLOYED/);
  assert.match(proc.stdout,/NOT CERTIFIED/);
  assert.doesNotMatch(proc.stdout,/SEDEAGRO_BUILD_SHA|PATH=|manifest.json/);
});

test('mutating one layer byte (same TAR length) fails even with original receipt',async t=>{
  const {f}=await validReceipt(t);
  const bytes=readFileSync(f.bundlePath);
  const point=bytes.indexOf(Buffer.from('backend:synthetic uncompressed rootfs bytes'));
  assert.ok(point>0);
  bytes[point]^=1;
  writeFileSync(f.bundlePath,bytes);
  await assert.rejects(
    verifyReceipt({bundlePath:f.bundlePath,receiptPath:f.receiptPath,sha:SHA}),
    /diff_id does not match/
  );
});
test('rejects swapped config, revision or tags before any receipt is created',async t=>{
  for(const options of [{revision:'c'.repeat(40)},{wrongLayer:true},
    {extraTag:true},{missingLayer:true}]){
    const f=fixture(t,options);
    await assert.rejects(computeReceipt({bundlePath:f.bundlePath,sha:SHA}),
      /OCI_BUNDLE_BLOCKED/);
  }
});
test('refuses unreferenced extra binary members, duplicate config files, symlink TAR member',async t=>{
  for(const options of [
    {extra:[{name:'blobs/sha256/'+ 'c'.repeat(64),data:'unreferenced'}]},
    {extra:[{name:'secrets.txt',data:'unexpected content'}]},
    {duplicate:true},
    {extra:[{name:'unexpected-symlink',data:'',type:'2'}]}
  ]){
    const f=fixture(t,options);
    await assert.rejects(computeReceipt({bundlePath:f.bundlePath,sha:SHA}),
      /OCI_BUNDLE_BLOCKED/);
  }
});
test('rejects TAR traversal and absolute paths without ever extracting',t=>{
  for(const name of ['../private.tar','/etc/shadow','dir/../../escape',
    'dir\\windows.txt','dir/./file.txt']){
    const f=fixture(t,{extra:[{name,data:'hello'}]});
    assert.throws(()=>inspectDockerSaveTar(f.bundlePath),/unsafe archive member path/);
  }
});
test('rejects malformed TAR header, missing terminator, nonzero tail and truncation',t=>{
  for(const transform of [
    data=>{data[148]^=1;return data;},
    data=>{data.fill(1,data.length-1024);return data;},
    data=>Buffer.concat([data,Buffer.alloc(512,7)]),
    data=>data.subarray(0,data.length-512)
  ]){
    const f=fixture(t);
    writeFileSync(f.bundlePath,transform(Buffer.from(f.contents)));
    assert.throws(()=>inspectDockerSaveTar(f.bundlePath),/OCI_BUNDLE_BLOCKED/);
  }
});
test('forged receipt, SHA mismatch and receipt symlink fail closed',async t=>{
  const {f}=await validReceipt(t);
  await assert.rejects(verifyReceipt({
    bundlePath:f.bundlePath,receiptPath:f.receiptPath,sha:'c'.repeat(40)
  }),/OCI_BUNDLE_BLOCKED/);
  const receipt=JSON.parse(readFileSync(f.receiptPath,'utf8'));
  receipt.images[0].config_id='sha256:'+'e'.repeat(64);
  writeFileSync(f.receiptPath,JSON.stringify(receipt));
  await assert.rejects(verifyReceipt({
    bundlePath:f.bundlePath,receiptPath:f.receiptPath,sha:SHA
  }),/OCI_BUNDLE_BLOCKED/);
  rmSync(f.receiptPath);
  symlinkSync(f.bundlePath,f.receiptPath);
  await assert.rejects(verifyReceipt({
    bundlePath:f.bundlePath,receiptPath:f.receiptPath,sha:SHA
  }),/OCI_BUNDLE_BLOCKED/);
});
test('real local Docker image inspection must agree with archive configs and layer diffIDs',async t=>{
  const f=fixture(t);
  await assert.rejects(createCIReceipt({
    bundlePath:f.bundlePath,receiptPath:f.receiptPath,sha:SHA,
    imageInspect:tag=>({
      ...dockerIdentity(f,tag.startsWith('sedeagro-backend')?'backend':'frontend'),
      Id:'sha256:'+'d'.repeat(64)
    })
  }),/live built local Docker image differs/);
  await assert.rejects(createCIReceipt({
    bundlePath:f.bundlePath,receiptPath:f.receiptPath,sha:SHA,
    imageInspect:tag=>({
      ...dockerIdentity(f,tag.startsWith('sedeagro-backend')?'backend':'frontend'),
      RootFS:{Layers:['sha256:'+'f'.repeat(64)]}
    })
  }),/live built local Docker image differs/);
});
test('CLI create is disabled outside exact-sha GitHub CI, with errors redacted',t=>{
  const f=fixture(t);
  const proc=spawnSync(process.execPath,[cli,'create','--sha',SHA,
    '--bundle',f.bundlePath,'--receipt',f.receiptPath],{
    encoding:'utf8',timeout:7000,
    env:{...process.env,CI:'false',GITHUB_ACTIONS:'false',
      IMAGE_SHA:SHA,JWT_SECRET:'NEVER_LOG_CI_SECRET'}
  });
  assert.equal(proc.status,2);
  assert.match(proc.stderr,/BLOCKED OCI release bundle/);
  assert.doesNotMatch(proc.stderr+proc.stdout,/NEVER_LOG_CI_SECRET|temporary-ci/);
});
test('workflow runs real docker save on paired immutable images and archives only main',()=>{
  const source=readFileSync(join(root,'.github/workflows/postgres-isolation.yml'),'utf8');
  const job=source.split('  production-images:')[1]?.split('  dependency-security:')[0]||'';
  assert.match(job,/docker save --output/);
  assert.match(job,/node scripts\/oci-release-bundle.mjs create/);
  assert.match(job,/node scripts\/oci-release-bundle.mjs verify/);
  assert.match(job,/actions\/upload-artifact@v4/);
  assert.match(job,/github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
  assert.doesNotMatch(job,/^\s+docker (?:push|load|compose up)\b/m);
});
