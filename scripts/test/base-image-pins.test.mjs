import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  validateBaseImageLock, validateBaseImageSources,
  validateImagetoolsOutput, inspectPinnedDigests
} from '../verify-base-image-pins.mjs';

const read = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
const load = () => JSON.parse(read('scripts/base-image-lock.json'));
const filenames = [
  'backend/Dockerfile', 'frontend/Dockerfile', 'docker-compose.yml',
  'docker-compose.dev.yml', 'docker-compose.staging.yml',
  '.github/workflows/postgres-isolation.yml'
];
const fixture = () => Object.fromEntries(filenames.map(p => [p, read(p)]));
const digest = key => load().images[key].digest;
const pinned = key => load().images[key].tag + '@' + digest(key);

test('reviewed lock has exactly four nonempty digests, distinct sources and expected media types', () => {
  const refs = validateBaseImageLock(load());
  assert.deepEqual(Object.keys(refs), ['node','nginx','postgis','redis']);
  assert.equal(load().platform,'linux/amd64');
  assert.match(refs.node, /^node:22-alpine@sha256:[a-f0-9]{64}$/);
  assert.match(refs.nginx, /^nginx:1\.27-alpine@sha256:[a-f0-9]{64}$/);
  assert.match(refs.postgis, /^postgis\/postgis:16-3\.4@sha256:[a-f0-9]{64}$/);
  assert.match(refs.redis, /^redis:7-alpine@sha256:[a-f0-9]{64}$/);
  assert.equal(new Set(Object.values(refs)).size,4);
});

test('all Dockerfiles, three Compose targets and PostGIS Actions service are pinned', () => {
  const result=validateBaseImageSources(load(),fixture());
  assert.equal(result.status,'BASE_IMAGE_SOURCES_PINNED_REVIEW_REQUIRED');
  assert.equal(result.source_files,6);
  assert.equal(result.unique_base_images,4);
  assert.equal(Object.values(result.references).reduce((a,b)=>a+b,0),11);
  assert.equal(result.registry_provenance_signed,false);
  assert.equal(result.staging_deployed,false);
  assert.doesNotMatch(JSON.stringify(result),/POSTGRES_PASSWORD|JWT_SECRET/);
});

test('tag-only fallback, changed digest or unreviewed image is blocked in EVERY target',()=>{
  const source=fixture(),lock=load();
  const cases=[
    ['backend/Dockerfile','node'],
    ['frontend/Dockerfile','nginx'],
    ['docker-compose.yml','redis'],
    ['docker-compose.dev.yml','postgis'],
    ['docker-compose.staging.yml','redis'],
    ['.github/workflows/postgres-isolation.yml','postgis']
  ];
  for(const [file,key] of cases) {
    const original=pinned(key);
    for(const replacement of [lock.images[key].tag,
      lock.images[key].tag+'@sha256:'+'f'.repeat(64),
      'latest:unsafe','redis:latest@sha256:'+'c'.repeat(64)]) {
      const files={...source,[file]:source[file].replace(original,replacement)};
      assert.notEqual(files[file],source[file]);
      assert.throws(()=>validateBaseImageSources(lock,files),
        /BASE_IMAGE_PIN_BLOCKED/,file+' should reject '+replacement);
    }
  }
});

test('unexpected FROM stage or extra data service is not permitted',()=>{
  const lock=load(),source=fixture();
  const backend={...source,'backend/Dockerfile':
    'FROM node:22-alpine@sha256:'+'1'.repeat(64)+' AS fake\n'+source['backend/Dockerfile']};
  assert.throws(()=>validateBaseImageSources(lock,backend),/BASE_IMAGE_PIN_BLOCKED/);
  const prod={...source,'docker-compose.yml':source['docker-compose.yml']+
    '\n  extra:\n    image: redis:7-alpine\n'};
  assert.throws(()=>validateBaseImageSources(lock,prod),/BASE_IMAGE_PIN_BLOCKED/);
  const missing={...source};
  delete missing['docker-compose.dev.yml'];
  assert.throws(()=>validateBaseImageSources(lock,missing),/BASE_IMAGE_PIN_BLOCKED/);
});

test('lock rejects changed tag, bad digest, duplicated digest and wrong manifest type',()=>{
  for(const mutate of [
    v=>{v.images.node.tag='node:latest';},
    v=>{v.images.node.digest='sha256:invalid';},
    v=>{v.images.nginx.digest=v.images.node.digest;},
    v=>{v.images.postgis.media_type='application/vnd.oci.image.index.v1+json';},
    v=>{v.images.other={tag:'unknown',digest:'sha256:'+'a'.repeat(64)};},
    v=>{v.platform='linux/arm64';}
  ]){const lock=load();mutate(lock);
    assert.throws(()=>validateBaseImageLock(lock),/BASE_IMAGE_PIN_BLOCKED/);}
});

const manifestOutput = (image,{digestOverride,mediaOverride,noPlatform=false}={}) =>
  'Name: docker.io/test@'+image.digest+'\n'+
  'MediaType: '+(mediaOverride||image.media_type)+'\n'+
  'Digest: '+(digestOverride||image.digest)+'\n'+
  (noPlatform?'':'  Platform: linux/amd64\n')+
  '  Platform: linux/arm64\n';

test('remote manifest inspector accepts exact digest and linux/amd64 for indexes',()=>{
  const lock=load();
  for(const image of Object.values(lock.images)) {
    assert.equal(validateImagetoolsOutput(manifestOutput(image),image),image.digest);
  }
});

test('remote inspector fails wrong digest, changed media type, missing amd64 and invalid result',()=>{
  const lock=load();
  const image=lock.images.node;
  for(const output of [
    manifestOutput(image,{digestOverride:'sha256:'+'0'.repeat(64)}),
    manifestOutput(image,{mediaOverride:'application/vnd.docker.distribution.manifest.v2+json'}),
    manifestOutput(image,{noPlatform:true}),
    'This image is untrusted', '{}', '', 'x'.repeat(262144)
  ])assert.throws(()=>validateImagetoolsOutput(output,image),/BASE_IMAGE_PIN_BLOCKED/);
});

test('online lookup uses digest-pinned Docker arguments, never tag-only or pull',()=>{
  const lock=load(),calls=[];
  const result=inspectPinnedDigests(lock,args=>{
    calls.push(args);
    assert.deepEqual(args.slice(0,3),['buildx','imagetools','inspect']);
    const key=Object.keys(lock.images).find(key=>args[3]===pinned(key));
    assert.ok(key,'only exact reviewed image digest should be inspected');
    return manifestOutput(lock.images[key]);
  });
  assert.equal(result.status,'PINNED_REGISTRY_MANIFESTS_REACHABLE_NOT_DEPLOYED');
  assert.equal(result.verified,4);
  assert.equal(result.postgis_platform_confirmed_by_runtime_service,false);
  assert.equal(calls.length,4);
});

test('online lookup blocks Docker output mismatch without falling back to mutable tags',()=>{
  const lock=load(),calls=[];
  assert.throws(()=>inspectPinnedDigests(lock,args=>{
    calls.push(args);
    return manifestOutput(lock.images.node);
  }),/BASE_IMAGE_PIN_BLOCKED/);
  assert.ok(calls.length>=2);
  assert.ok(calls.every(x=>x[3].includes('@sha256:')));
});

test('offline CLI succeeds without Docker or CI and online CLI refuses non-CI',()=>{
  const cli=fileURLToPath(new URL('../verify-base-image-pins.mjs',import.meta.url));
  const offline=spawnSync(process.execPath,[cli,'--offline'],{
    encoding:'utf8',timeout:7000,env:{...process.env,
      CI:'false',GITHUB_ACTIONS:'false'}});
  assert.equal(offline.status,0,offline.stderr);
  assert.match(offline.stdout,/BASE_IMAGE_SOURCES_PINNED_REVIEW_REQUIRED/);
  const online=spawnSync(process.execPath,[cli,'--online'],{
    encoding:'utf8',timeout:7000,env:{...process.env,
      CI:'false',GITHUB_ACTIONS:'false',JWT_SECRET:'PRIVATE_NOT_IN_LOG'}});
  assert.equal(online.status,2);
  assert.match(online.stderr,/BLOCKED base image pins/);
  assert.doesNotMatch(online.stdout+online.stderr,/PRIVATE_NOT_IN_LOG/);
});

test('CI runs static and live digest gate before image builds on exact PR and main',()=>{
  const w=read('.github/workflows/postgres-isolation.yml');
  const unit=w.split('  tenant-rls:')[1]?.split('  browser-offline:')[0]||'';
  const prod=w.split('  production-images:')[1]?.split('  dependency-security:')[0]||'';
  assert.match(unit,/scripts\/verify-base-image-pins\.mjs --offline/);
  assert.match(unit,/scripts\/test\/base-image-pins\.test\.mjs/);
  assert.match(prod,/scripts\/verify-base-image-pins\.mjs --online/);
  assert.ok(prod.indexOf('scripts/verify-base-image-pins.mjs --online')<
    prod.indexOf('Build backend production image'));
  assert.match(w,/image: postgis\/postgis:16-3\.4@sha256:[a-f0-9]{64}/);
});
