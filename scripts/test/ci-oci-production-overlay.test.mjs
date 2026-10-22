import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readFileSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  inspectProductionOverlay,validateProductionOverlay,withSyntheticComposeFiles
} from '../ci-oci-production-overlay.mjs';

const SHA='a'.repeat(40);
const digest=c=>'sha256:'+c.repeat(64);
const images=['backend','frontend'].map((service,i)=>({
  service,tag:'sedeagro-'+service+'-rc:'+SHA,
  config_id:digest(i?'b':'c')
}));
const receipt={head:SHA,archive:{
  name:'sedeagro-images-'+SHA+'.tar',sha256:'d'.repeat(64)
},images};
const review={
  status:'CI_OCI_IMAGE_ONLY_COMPOSE_REVIEW_NOT_DEPLOYED',
  head:SHA,archive_sha256:'d'.repeat(64),
  imported_images:{backend:images[0].config_id,frontend:images[1].config_id},
  image_pull_allowed:false,image_rebuild_allowed:false,
  container_started:false,production_deploy_certified:false,
  signed_release_approval:false,time_of_use_certified:false
};
const DB='postgis/postgis:16-3.4@sha256:44126d872ac91993766c341e369c539e8196614321765d36a6f1bab0419a5fa5';
const REDIS='redis:7-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499';
function baseline(){return {
  name:'sedeagro',volumes:{sedeagro_db:{name:'sedeagro_sedeagro_db'},
    sedeagro_redis:{name:'sedeagro_sedeagro_redis'}},
  networks:{'fedes-net':{external:true,name:'fedes-net'},
    sedeagro_internal:{name:'sedeagro_internal'}},
  services:{
    db:{image:DB,volumes:['sedeagro_db:/var/lib/postgresql/data'],networks:{sedeagro_internal:null}},
    redis:{image:REDIS,networks:{sedeagro_internal:null}},
    backend:{build:{context:'/tmp/backend',target:'prod'},
      restart:'unless-stopped',environment:{PORT:3001},
      depends_on:{db:{condition:'service_healthy'},redis:{condition:'service_started'}},
      networks:{sedeagro_internal:null}},
    frontend:{build:{context:'/tmp/frontend',target:'prod'},
      networks:{sedeagro_internal:null,'fedes-net':null},restart:'unless-stopped'}
  }
};}
function candidate(base=baseline()){
  const result=structuredClone(base);
  for(const [i,s] of ['backend','frontend'].entries()){
    delete result.services[s].build;
    result.services[s].image=images[i].tag;
    result.services[s].pull_policy='never';
  }
  return result;
}
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'sedeagro-overlay-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const receiptPath=join(dir,'sedeagro-images-'+SHA+'.json'),
    bundlePath=join(dir,'sedeagro-images-'+SHA+'.tar');
  writeFileSync(receiptPath,JSON.stringify(receipt));
  writeFileSync(bundlePath,'synthetic; reviewed prior OCI runner result injected');
  return {receiptPath,bundlePath};
}
function fakeDocker(base=baseline(),preview=candidate(base)){
  const calls=[];
  const execute=(args,env)=>{
    calls.push(args.slice());
    assert.equal(args[0],'compose');
    assert.ok(args.includes('--no-env-resolution'));
    assert.ok(args.includes('--format'));
    assert.equal(env.SEDEAGRO_RELEASE_SHA,SHA);
    assert.equal(env.SEDEAGRO_OCI_BACKEND_IMAGE,images[0].tag);
    assert.equal(env.SEDEAGRO_OCI_FRONTEND_IMAGE,images[1].tag);
    assert.equal(env.COMPOSE_DISABLE_ENV_FILE,'1');
    return JSON.stringify(args.filter(x=>x==='-f').length===1?base:preview);
  };
  return {execute,calls};
}
function opts(f,d,more={}){return {...f,sha:SHA,
  review:async()=>review,execute:d.execute,...more};}

test('production topology overlay makes exact 2-image no-build/no-pull preview, never starts services',async t=>{
  const f=fixture(t),d=fakeDocker();
  const r=await inspectProductionOverlay(opts(f,d));
  assert.equal(r.status,'CI_OCI_PRODUCTION_TOPOLOGY_OVERLAY_VALIDATED_NOT_DEPLOYED');
  assert.deepEqual(r.imported_images,review.imported_images);
  assert.equal(r.secrets_loaded,false);
  assert.equal(r.container_started,false);
  assert.equal(r.production_deploy_certified,false);
  assert.equal(r.time_of_use_certified,false);
  assert.deepEqual(d.calls.map(x=>x.slice(-4)),[
    ['config','--no-env-resolution','--format','json'],
    ['config','--no-env-resolution','--format','json']
  ]);
  assert.ok(d.calls.every(args=>!args.some(a=>['up','run','start','build','pull','load','push'].includes(a))));
});

test('baseline production project and dependency digests must be unchanged',()=>{
  const transforms=[
    x=>{x.name='staging';},
    x=>{delete x.services.db;},
    x=>{x.services.worker={image:'worker:latest'};},
    x=>{x.services.db.image='postgis:latest';},
    x=>{x.services.redis.image='redis:latest';},
    x=>{x.services.db.ports=['0.0.0.0:5432:5432'];},
    x=>{x.services.redis.privileged=true;},
    x=>{x.networks['fedes-net'].external=false;},
    x=>{delete x.volumes.sedeagro_db;},
    x=>{delete x.services.backend.build;},
    x=>{x.services.frontend.image='nginx:latest';},
    x=>{x.services.backend.ports=['3001:3001'];}
  ];
  for(const apply of transforms){
    const base=baseline();apply(base);
    assert.throws(()=>validateProductionOverlay(base,candidate(base),receipt,SHA),
      /OCI_PRODUCTION_OVERLAY_BLOCKED/);
  }
});

test('override must contain ONLY removed builds plus exact tags and never pull',()=>{
  const transforms=[
    x=>{x.services.frontend.build={context:'/tmp'};},
    x=>{x.services.backend.image='sedeagro-backend-rc:'+'f'.repeat(40);},
    x=>{x.services.frontend.image='sha256:'+'e'.repeat(64);},
    x=>{x.services.frontend.pull_policy='always';},
    x=>{delete x.services.backend.pull_policy;},
    x=>{x.services.backend.privileged=true;},
    x=>{x.services.frontend.ports=['443:80'];},
    x=>{x.services.backend.volumes=['/etc:/etc'];},
    x=>{x.services.backend.environment.NEW='anything';},
    x=>{x.services.redis.image='redis:edge';},
    x=>{x.services.db.healthcheck={test:'always ok'};},
    x=>{x.services.frontend.networks={sedeagro_internal:null};},
    x=>{x.networks.malicious={};},
    x=>{x.services.extra={image:'alpine:latest'};},
    x=>{x.services.frontend.restart='always';}
  ];
  for(const apply of transforms){
    const base=baseline(),x=candidate(base);
    apply(x);
    assert.throws(()=>validateProductionOverlay(base,x,receipt,SHA),
      /OCI_PRODUCTION_OVERLAY_BLOCKED/);
  }
});

test('missing or mismatched imported archive evidence prevents composing with Docker',async t=>{
  const f=fixture(t),d=fakeDocker();
  for(const bad of [
    {...review,head:'f'.repeat(40)},
    {...review,status:'NOT_VERIFIED'},
    {...review,image_pull_allowed:true},
    {...review,image_rebuild_allowed:true},
    {...review,container_started:true},
    {...review,time_of_use_certified:true},
    {...review,production_deploy_certified:true},
    {...review,signed_release_approval:true},
    {...review,imported_images:{backend:digest('e'),frontend:digest('f')}}
  ]){
    await assert.rejects(inspectProductionOverlay(opts(f,d,{review:async()=>bad})),
      /OCI_PRODUCTION_OVERLAY_BLOCKED/);
  }
  assert.equal(d.calls.length,0);
});

test('receipt and Docker config identities match before reading Compose preview',async t=>{
  const f=fixture(t),d=fakeDocker();
  for(const altered of [
    x=>{x.archive.sha256='f'.repeat(64);},
    x=>{x.archive.name='wrong.tar';},
    x=>{x.images[1].config_id=digest('f');},
    x=>{x.head='f'.repeat(40);}
  ]){
    const r=structuredClone(receipt);altered(r);
    writeFileSync(f.receiptPath,JSON.stringify(r));
    await assert.rejects(inspectProductionOverlay(opts(f,d)),
      /OCI_PRODUCTION_OVERLAY_BLOCKED/);
  }
  assert.equal(d.calls.length,0);
});

test('Compose v2 renders base and OCI override without secrets on disposable CI',t=>{
  const version=spawnSync('docker',['compose','version'],{encoding:'utf8',timeout:5000});
  if(version.status!==0){t.skip('Compose not installed locally');return;}
  const env={PATH:process.env.PATH,HOME:process.env.HOME,
    COMPOSE_DISABLE_ENV_FILE:'1',
    SEDEAGRO_RELEASE_SHA:SHA,SEDEAGRO_OCI_BACKEND_IMAGE:images[0].tag,
    SEDEAGRO_OCI_FRONTEND_IMAGE:images[1].tag,
    POSTGRES_PASSWORD:'DISPOSABLE_REVIEW_ONLY',
    APP_DB_PASSWORD:'DISPOSABLE_REVIEW_ONLY'};
  withSyntheticComposeFiles(({prod,overlay})=>{
    const run=args=>spawnSync('docker',args,{
      encoding:'utf8',timeout:15000,env});
    const config=['config','--no-env-resolution','--format','json'];
    const a=run(['compose','-f',prod,...config]);
    const b=run(['compose','-f',prod,'-f',overlay,...config]);
    assert.equal(a.status,0,'BASE COMPOSE FORMAT INVALID: '+a.stderr.slice(0,120));
    assert.equal(b.status,0,'OCI OVERRIDE FORMAT INVALID: '+b.stderr.slice(0,120));
    assert.deepEqual(validateProductionOverlay(
      JSON.parse(a.stdout),JSON.parse(b.stdout),receipt,SHA),
    review.imported_images);
    assert.doesNotMatch(b.stdout,/"build"\s*:/);
  });
});

test('standalone CLI refuses user terminal and never prints environment secrets',t=>{
  const f=fixture(t);
  const cli=fileURLToPath(new URL('../ci-oci-production-overlay.mjs',import.meta.url));
  const r=spawnSync(process.execPath,[cli,'--sha',SHA,
    '--bundle',f.bundlePath,'--receipt',f.receiptPath],{
    encoding:'utf8',timeout:6000,
    env:{...process.env,CI:'false',GITHUB_ACTIONS:'false',
      JWT_SECRET:'NO_SECRET_IN_LOGS'}
  });
  assert.equal(r.status,2);
  assert.match(r.stderr,/BLOCKED OCI production preview/);
  assert.doesNotMatch(r.stderr+r.stdout,/NO_SECRET_IN_LOGS/);
});

test('workflow runs production dry-run only after signed OCI import and review, never up',()=>{
  const wf=readFileSync(new URL('../../.github/workflows/postgres-isolation.yml',import.meta.url),'utf8');
  const receiver=wf.split('  offline-image-import:')[1]||'';
  const admit=receiver.indexOf('verify-image-security.mjs --mode verify-signed'),
    load=receiver.indexOf('ci-oci-import-rehearsal.mjs --mode fresh'),
    review=receiver.indexOf('ci-oci-compose-parity.mjs --sha'),
    preview=receiver.indexOf('ci-oci-production-overlay.mjs --sha');
  assert.ok(admit>=0&&load>admit&&review>load&&preview>review);
  assert.doesNotMatch(receiver,/\bdocker compose (?:up|run|start|build|pull)\b/);
  const prod=readFileSync(new URL('../../scripts/deploy-prod.sh',import.meta.url),'utf8');
  const gate=readFileSync(new URL('../../scripts/production-preflight.sh',import.meta.url),'utf8');
  assert.match(prod,/docker compose build backend frontend/);
  assert.match(gate,/verify-production-image-admission.mjs/);
});
