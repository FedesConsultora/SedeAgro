import test from 'node:test';
import { readFileSync } from 'node:fs';
const baseLock = JSON.parse(readFileSync(new URL('../base-image-lock.json', import.meta.url), 'utf8'));
const locked = key => baseLock.images[key].tag + '@' + baseLock.images[key].digest;

import assert from 'node:assert/strict';
import { validateStagingContainers, inspectStagingRuntime } from '../verify-staging-runtime.mjs';

const sha='a'.repeat(40);
const host='staging.ci.test';
const project='sedeagro-staging';
const network=project+'_staging_internal';
const imageId=letter=>'sha256:'+letter.repeat(64);

function container(name, letter) {
  return {
    Image:imageId(letter),
    RestartCount:0,
    State:{Running:true,Status:'running',Health:{Status:'healthy'}},
    Config:{
      Image:name==='db'?locked('postgis'):
        name==='redis'?locked('redis'):'sedeagro-staging-'+name+':'+sha,
      Labels:{
        'com.docker.compose.project':project,
        'com.docker.compose.service':name,
        ...(name==='backend'||name==='frontend'?{
          'org.opencontainers.image.revision':sha
        }:{})
      },
      Env:name==='backend'?[
        'NODE_ENV=production','SEED_MODE=prod','LOG_SQL=0','LOG_STACK=0',
        'BASE_DOMAIN='+host,'CORS_ORIGIN=https://'+host,'SEDEAGRO_BUILD_SHA='+sha,
        'DATABASE_URL=postgres://sedeagro_staging_app:'+'x'.repeat(40)+'@db:5432/sedeagro_staging',
        'JWT_SECRET='+'PRIVATE-NOT-IN-OUTPUT-'+'j'.repeat(40)
      ]:[]
    },
    HostConfig:{
      Privileged:false,
      NetworkMode:network,
      PortBindings:name==='frontend'?{'80/tcp':[{HostIp:'127.0.0.1',HostPort:'4183'}]}:{}
    },
    NetworkSettings:{Networks:{[network]:{}}},
    Mounts:name==='db'?[{Type:'volume',Name:project+'_staging_pgdata'}]:
      name==='redis'?[{Type:'volume',Name:project+'_staging_redisdata'}]:[]
  };
}
const fixture=()=>({
  db:container('db','1'),redis:container('redis','2'),
  backend:container('backend','3'),frontend:container('frontend','4')
});

test('actual containers prove project, internal network, runtime image IDs and health',()=>{
  const res=validateStagingContainers(fixture(),{sha,host});
  assert.equal(res.status,'RUNTIME_REVIEW_REQUIRED');
  assert.equal(res.network,network);
  assert.equal(res.registry_digest_certified,false);
  assert.equal(res.tls_certified,false);
  assert.equal(res.database_isolation_certified,false);
  assert.equal(res.image_ids.backend,imageId('3'));
  assert.doesNotMatch(JSON.stringify(res),/PRIVATE-NOT-IN-OUTPUT|DATABASE_URL/);
});

test('inspect only Docker containers bearing exact isolated project/service labels',()=>{
  const f=fixture();
  const calls=[];
  const ids={db:'a'.repeat(12),redis:'b'.repeat(12),
    backend:'c'.repeat(12),frontend:'d'.repeat(12)};
  const execute=args=>{
    calls.push(args);
    if(args[0]==='container'){
      const service=args.at(-1).split('=').at(-1);
      return ids[service]+'\n';
    }
    const id=args.at(-1);
    const service=Object.keys(ids).find(key=>ids[key]===id);
    return JSON.stringify(f[service]);
  };
  const result=inspectStagingRuntime({sha,host,execute});
  assert.equal(result.services,4);
  assert.equal(calls.length,8);
  for(const call of calls.filter(args=>args[0]==='container')){
    assert.ok(call.includes('label=com.docker.compose.project=sedeagro-staging'));
    assert.ok(call.some(item=>item.startsWith('label=com.docker.compose.service=')));
    assert.doesNotMatch(call.join(' '),/production|fedes-net/);
  }
});

test('wrong project/service/network or same host production volume fails closed',()=>{
  const mutations=[
    c=>{c.db.Config.Labels['com.docker.compose.project']='sedeagro';},
    c=>{c.backend.Config.Labels['com.docker.compose.service']='frontend';},
    c=>{c.backend.NetworkSettings.Networks={sedeagro_internal:{}};},
    c=>{c.frontend.NetworkSettings.Networks['fedes-net']={};},
    c=>{c.db.Mounts[0].Name='sedeagro_sedeagro_db';},
    c=>{c.redis.Mounts[0].Type='bind';},
    c=>{c.backend.Mounts=[{Type:'bind',Source:'/srv/prod'}];},
    c=>{c.backend.HostConfig.PortBindings={'3001/tcp':[{HostIp:'127.0.0.1',HostPort:'3001'}]};},
    c=>{c.frontend.HostConfig.PortBindings['80/tcp'][0].HostIp='0.0.0.0';},
    c=>{c.frontend.HostConfig.PortBindings['80/tcp'][0].HostPort='80';},
    c=>{c.db.HostConfig.Privileged=true;},
    c=>{c.backend.HostConfig.NetworkMode='host';}
  ];
  for(const mutate of mutations){
    const c=fixture(); mutate(c);
    assert.throws(()=>validateStagingContainers(c,{sha,host}),/BLOCKED/);
  }
});

test('staging runtime denies mutable database/cache tags even for healthy containers',()=>{
  for(const [name,key] of [['db','postgis'],['redis','redis']]){
    const ref=locked(key);
    for(const value of [baseLock.images[key].tag,
      baseLock.images[key].tag+'@sha256:'+'e'.repeat(64)]){
      const c=fixture(); c[name].Config.Image=value;
      assert.notEqual(value,ref);
      assert.throws(()=>validateStagingContainers(c,{sha,host}),/BLOCKED/);
    }
  }
});

test('bad or unapproved revision, dev mode, prod DB and nonhealthy containers block',()=>{
  const changes=[
    c=>{c.frontend.Config.Image='sedeagro-frontend:'+sha;},
    c=>{c.frontend.Config.Labels['org.opencontainers.image.revision']='b'.repeat(40);},
    c=>{c.backend.Config.Env[0]='NODE_ENV=development';},
    c=>{c.backend.Config.Env[4]='BASE_DOMAIN=sedeagro.fedes.ai';},
    c=>{c.backend.Config.Env[7]='DATABASE_URL=postgres://sedeagro_staging_app:xxx@db:5432/sedeagro';},
    c=>{c.backend.Config.Env[6]='SEDEAGRO_BUILD_SHA='+'b'.repeat(40);},
    c=>{c.db.Config.Image='postgis/postgis:latest';},
    c=>{c.backend.RestartCount=1;},
    c=>{c.db.State.Health.Status='unhealthy';},
    c=>{c.redis.State.Running=false;},
    c=>{c.frontend.State.Status='exited';},
    c=>{c.frontend.Image='sha256:invalid';}
  ];
  for(const change of changes){
    const c=fixture();change(c);
    assert.throws(()=>validateStagingContainers(c,{sha,host}),/BLOCKED/);
  }
});

test('missing, duplicate, oversized or malformed Docker inspection always blocks',()=>{
  const c=fixture();
  delete c.redis;
  assert.throws(()=>validateStagingContainers(c,{sha,host}),/BLOCKED/);
  for(const output of ['', 'not-a-container','a'.repeat(12)+'\n'+'b'.repeat(12)]){
    const execute=args=>args[0]==='container'?output:'{}';
    assert.throws(()=>inspectStagingRuntime({sha,host,execute}),/BLOCKED/);
  }
  const execute=args=>args[0]==='container'?'a'.repeat(12):'{not json';
  assert.throws(()=>inspectStagingRuntime({sha,host,execute}));
});

test('unknown host and truncated SHA never reach Docker',()=>{
  let called=false;
  for(const [badSha,badHost] of [['a','staging.ci.test'],[sha,'sedeagro.fedes.ai']]){
    assert.throws(()=>inspectStagingRuntime({sha:badSha,host:badHost,
      execute:()=>{called=true;return '';}}),/BLOCKED/);
  }
  assert.equal(called,false);
});
