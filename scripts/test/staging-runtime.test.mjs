import test from 'node:test';
import { readFileSync } from 'node:fs';
const baseLock = JSON.parse(readFileSync(new URL('../base-image-lock.json', import.meta.url), 'utf8'));
const locked = key => baseLock.images[key].tag + '@' + baseLock.images[key].digest;

import assert from 'node:assert/strict';
import {
  validateStagingContainers, inspectStagingRuntime, validateStagingVolumeInventory,
  validateStagingNetworkInventory, validateStagingEffectivePorts,
  validateStagingBaseImageInventory
} from '../verify-staging-runtime.mjs';

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
        'JWT_SECRET='+'PRIVATE-NOT-IN-OUTPUT-'+'j'.repeat(40),
        'REDIS_URL=redis://redis:6379','PORT=3001',
        'LOG_LEVEL=info','LOG_FORMAT=json'
      ]:[]
    },
    HostConfig:{
      Privileged:false,
      NetworkMode:network,
      PortBindings:name==='frontend'?{'80/tcp':[{HostIp:'127.0.0.1',HostPort:'4183'}]}:{}
    },
    NetworkSettings:{
      Networks:{[network]:{}},
      Ports:name==='frontend'
        ? {'80/tcp':[{HostIp:'127.0.0.1',HostPort:'4183'}]}
        : {[name==='db'?'5432/tcp':name==='redis'?'6379/tcp':'3001/tcp']:null}
    },
    Mounts:name==='db'?[{Type:'volume',Name:project+'_staging_pgdata'}]:
      name==='redis'?[{Type:'volume',Name:project+'_staging_redisdata'}]:[]
  };
}
const fixture=()=>({
  db:container('db','1'),redis:container('redis','2'),
  backend:container('backend','3'),frontend:container('frontend','4')
});

// Independent image-store metadata for the two digest-locked base services.
function baseImageFixture(containers) {
  const repo={db:'postgis/postgis',redis:'redis'};
  const digest={db:baseLock.images.postgis.digest,redis:baseLock.images.redis.digest};
  return Object.fromEntries(['db','redis'].map(name=>[
    name,{Id:containers[name].Image,RepoDigests:[repo[name]+'@'+digest[name]]}
  ]));
}

test('signed staging checks base image-store digest and actual running IDs',()=>{
  const c=fixture(), images=baseImageFixture(c);
  assert.deepEqual(validateStagingBaseImageInventory(images,c),{
    db:imageId('1'),redis:imageId('2')
  });
});

test('signed staging blocks substituted, stale, unsigned-alias or missing base image metadata',()=>{
  const mutations=[
    (images,c)=>{c.db.Image=imageId('f');},
    (images,c)=>{c.redis.Image=imageId('f');},
    (images)=>{images.db.Id=imageId('f');},
    (images)=>{images.redis.RepoDigests=['redis@sha256:'+'f'.repeat(64)];},
    (images)=>{images.db.RepoDigests=['postgis/postgis:latest'];},
    (images)=>{images.db.RepoDigests=['other/postgis@'+baseLock.images.postgis.digest];},
    (images)=>{images.redis.RepoDigests=[];},
    (images)=>{images.redis.RepoDigests=undefined;},
    (images)=>{images.db.Id='truncated';},
    (images)=>{images.db.Id=images.redis.Id;},
    (images)=>{images.extra={Id:imageId('f')};},
    (images)=>{delete images.redis;},
    (images,c)=>{c.db.Config.Image='postgis/postgis:latest';},
    (images,c)=>{c.redis.Config.Image='redis:latest';}
  ];
  for(const mutate of mutations){
    const c=fixture(),images=baseImageFixture(c);
    mutate(images,c);
    assert.throws(()=>validateStagingBaseImageInventory(images,c),
      /STAGING_RUNTIME_BLOCKED/,mutate.toString());
  }
  // Some registries display Docker Hub's fully-qualified canonical name.
  const c=fixture(),images=baseImageFixture(c);
  images.redis.RepoDigests=['docker.io/library/redis@'+baseLock.images.redis.digest];
  images.db.RepoDigests=['docker.io/postgis/postgis@'+baseLock.images.postgis.digest];
  assert.equal(validateStagingBaseImageInventory(images,c).redis,c.redis.Image);
});

// Only signed runtime inspection reads Docker's independent volume metadata.
function volumeFixture(containers) {
  const result = {};
  for(const [name,short,destination] of [
    ['db','staging_pgdata','/var/lib/postgresql/data'],
    ['redis','staging_redisdata','/data']
  ]) {
    const full=project+'_'+short;
    const path='/var/lib/docker/volumes/'+full+'/_data';
    result[name]={
      Name:full,Driver:'local',Scope:'local',Mountpoint:path,Options:null,
      Labels:{
        'com.docker.compose.project':project,
        'com.docker.compose.volume':short,
        'com.docker.compose.version':'2.0.0'
      }
    };
    Object.assign(containers[name].Mounts[0],{
      Driver:'local',Source:path,Destination:destination,
      RW:true,Propagation:''
    });
  }
  return result;
}

function changeBackendEnv(c,key,value) {
  const index=c.backend.Config.Env.findIndex(entry=>entry.startsWith(key+'='));
  assert.ok(index>=0, 'fixture must declare '+key);
  if(value===undefined) c.backend.Config.Env.splice(index,1);
  else c.backend.Config.Env[index]=key+'='+value;
}

test('staging rejects any Redis endpoint drift even when all four containers are healthy',()=>{
  const bad=[
    'redis://production-redis:6379',
    'redis://redis:6380',
    'rediss://redis:6379',
    'redis://redis:6379/1',
    'redis://redis:6379?db=0',
    'redis://admin:password@redis:6379',
    'redis://127.0.0.1:6379',
    'redis://redis:6379#shadow',
    '',
    undefined
  ];
  for(const value of bad){
    const c=fixture();
    changeBackendEnv(c,'REDIS_URL',value);
    assert.throws(()=>validateStagingContainers(c,{sha,host}),
      /STAGING_RUNTIME_BLOCKED/,String(value));
  }
  const ok=validateStagingContainers(fixture(),{sha,host});
  assert.equal(ok.status,'RUNTIME_REVIEW_REQUIRED');
});

test('staging denies alternate PostgreSQL authority, options and weak or reused secrets',()=>{
  const validUser='sedeagro_staging_app',validPassword='x'.repeat(40);
  const base='postgres://'+validUser+':'+validPassword+'@db:5432/sedeagro_staging';
  const bad=[
    'postgres://'+validUser+':'+validPassword+'@prod-db:5432/sedeagro_staging',
    'postgres://'+validUser+':'+validPassword+'@db:5432/production',
    'postgres://'+validUser+':'+validPassword+'@db:5433/sedeagro_staging',
    'postgres://sedeagro_staging_owner:'+validPassword+'@db:5432/sedeagro_staging',
    base.replace('postgres://','postgresql://'),
    base.replace('postgres://','http://'),
    base+'?sslmode=disable',
    base+'#fragment',
    base.replace(':'+validPassword+'@',':short@'),
    base.replace(':'+validPassword+'@',':@'),
    base.replace(':'+validPassword+'@',':password-example-secret@'),
    base.replace(':'+validPassword+'@',':jwt%40pass@'),
    undefined
  ];
  for(const value of bad){
    const c=fixture();
    changeBackendEnv(c,'DATABASE_URL',value);
    assert.throws(()=>validateStagingContainers(c,{sha,host}),
      /STAGING_RUNTIME_BLOCKED/,String(value));
  }
  for(const [name,value] of [
    ['JWT_SECRET',validPassword],['JWT_SECRET','too-short'],
    ['JWT_SECRET',undefined],['LOG_LEVEL','debug'],['LOG_FORMAT','text'],
    ['PORT','3002'],['LOG_LEVEL',undefined],['PORT',undefined]
  ]){
    const c=fixture();
    changeBackendEnv(c,name,value);
    assert.throws(()=>validateStagingContainers(c,{sha,host}),
      /STAGING_RUNTIME_BLOCKED/,name+'='+value);
  }
});

test('signed OCI runtime review also validates live staging-only DB and Redis endpoints',()=>{
  const signed={backend:imageId('3'),frontend:imageId('4')};
  const make=()=>{
    const c=fixture();
    for(const [i,name] of ['db','redis','backend','frontend'].entries())
      c[name].Id=String(i+5).repeat(64);
    c.backend.Config.Image=signed.backend;
    c.frontend.Config.Image=signed.frontend;
    return c;
  };
  const ok=validateStagingContainers(make(),{sha,host,signedImageIds:signed});
  assert.equal(ok.image_reference_kind,'immutable-config-id');
  for(const [key,value] of [
    ['REDIS_URL','redis://production-redis:6379'],
    ['DATABASE_URL','postgres://sedeagro_staging_app:'+'x'.repeat(40)+'@db:5432/sedeagro_staging?sslmode=disable'],
    ['JWT_SECRET','x'.repeat(40)]
  ]){
    const c=make();
    changeBackendEnv(c,key,value);
    assert.throws(()=>validateStagingContainers(c,{sha,host,signedImageIds:signed}),
      /STAGING_RUNTIME_BLOCKED/);
  }
});

test('signed volume inventory rejects remote drivers, bind options and spoofed project labels',()=>{
  const mutations=[
    v=>{v.db.Driver='nfs';},
    v=>{v.redis.Scope='global';},
    v=>{v.db.Options={type:'none',device:'/srv/prod',o:'bind'};},
    v=>{v.db.Labels['com.docker.compose.project']='sedeagro';},
    v=>{v.redis.Labels['com.docker.compose.volume']='staging_pgdata';},
    v=>{v.db.Mountpoint='/srv/production/volumes/staging_data/_data';},
    v=>{v.db.Mountpoint='/var/lib/docker/volumes/../volumes/'+project+'_staging_pgdata/_data';},
    v=>{v.redis.Name='sedeagro_redisdata';},
    v=>{v.db.Mountpoint='/var/lib/docker/volumes/'+project+'_staging_redisdata/_data';},
    v=>{v.db.Options=['type=none'];}
  ];
  for(const mutation of mutations){
    const c=fixture(), v=volumeFixture(c);
    mutation(v);
    assert.throws(()=>validateStagingVolumeInventory(v,c),
      /STAGING_RUNTIME_BLOCKED/);
  }
  for(const modify of [
    c=>{c.db.Mounts[0].Source='/var/lib/docker/volumes/production/_data';},
    c=>{c.redis.Mounts[0].Driver='nfs';},
    c=>{c.db.Mounts[0].Destination='/srv/production';},
    c=>{c.db.Mounts[0].RW=false;},
    c=>{c.db.Mounts[0].Propagation='shared';},
    c=>{c.redis.Mounts[0].Type='bind';},
    c=>{c.redis.Mounts.push({Type:'bind',Source:'/srv'});}
  ]){
    const c=fixture(),v=volumeFixture(c);modify(c);
    assert.throws(()=>validateStagingVolumeInventory(v,c),
      /STAGING_RUNTIME_BLOCKED/);
  }
  const c=fixture(),v=volumeFixture(c);
  assert.equal(validateStagingVolumeInventory(v,c),true);
  assert.equal(v.db.Options,null);
});

// Signed OCI only: independent Docker network inspect and container-endpoint parity.
function networkFixture(containers) {
  const id='9'.repeat(64);
  const net={
    Name:network,Id:id,Driver:'bridge',Scope:'local',Internal:true,
    Attachable:false,Ingress:false,ConfigOnly:false,Options:{},
    Labels:{
      'com.docker.compose.project':project,
      'com.docker.compose.network':'staging_internal'
    },
    Containers:{}
  };
  for(const [i,name] of ['db','redis','backend','frontend'].entries()) {
    const c=containers[name],endpointId=String.fromCharCode(97+i).repeat(64);
    c.Name='/'+project+'-'+name+'-1';
    c.NetworkSettings.Networks[network]={
      NetworkID:id,EndpointID:endpointId
    };
    net.Containers[c.Id]={
      Name:c.Name.slice(1),EndpointID:endpointId
    };
  }
  return net;
}

test('signed staging checks real private network and exact four attached containers',()=>{
  const c=fixture();
  for(const [i,name] of ['db','redis','backend','frontend'].entries())
    c[name].Id=String(i+5).repeat(64);
  const n=networkFixture(c);
  assert.equal(validateStagingNetworkInventory(n,c),n.Id);
  assert.doesNotMatch(JSON.stringify({network_id:n.Id}),/PRIVATE-NOT-IN-OUTPUT/);
});

test('signed OCI staging blocks public, externally attachable or mislabeled Docker networks',()=>{
  const attacks=[
    n=>{n.Internal=false;},
    n=>{n.Driver='macvlan';},
    n=>{n.Driver='overlay';},
    n=>{n.Scope='swarm';},
    n=>{n.Attachable=true;},
    n=>{n.Ingress=true;},
    n=>{n.ConfigOnly=true;},
    n=>{n.Options={'com.docker.network.bridge.name':'production0'};},
    n=>{n.Name='sedeagro_internal';},
    n=>{n.Id='not-64-hex';},
    n=>{n.Labels['com.docker.compose.project']='sedeagro';},
    n=>{n.Labels['com.docker.compose.network']='production';},
    n=>{n.Containers['f'.repeat(64)]={Name:'production',EndpointID:'1'.repeat(64)};},
    n=>{delete n.Containers['5'.repeat(64)];},
    n=>{n.Containers['6'.repeat(64)].Name='production-redis';},
    n=>{n.Containers['7'.repeat(64)].EndpointID='f'.repeat(64);}
  ];
  for(const mutate of attacks){
    const c=fixture();
    for(const [i,name] of ['db','redis','backend','frontend'].entries())
      c[name].Id=String(i+5).repeat(64);
    const n=networkFixture(c);
    mutate(n);
    assert.throws(()=>validateStagingNetworkInventory(n,c),
      /STAGING_RUNTIME_BLOCKED/);
  }
});

test('signed OCI staging denies swapped, duplicated or unbound endpoint identity',()=>{
  const attacks=[
    c=>{c.backend.NetworkSettings.Networks[network].NetworkID='e'.repeat(64);},
    c=>{c.db.NetworkSettings.Networks[network].EndpointID='f'.repeat(64);},
    c=>{c.redis.NetworkSettings.Networks[network].EndpointID=
      c.db.NetworkSettings.Networks[network].EndpointID;},
    c=>{c.frontend.Name='/sedeagro-frontend-1';},
    c=>{c.db.Id='1'.repeat(64);},
    c=>{delete c.redis.NetworkSettings.Networks[network];}
  ];
  for(const mutate of attacks){
    const c=fixture();
    for(const [i,name] of ['db','redis','backend','frontend'].entries())
      c[name].Id=String(i+5).repeat(64);
    const n=networkFixture(c);
    mutate(c);
    assert.throws(()=>validateStagingNetworkInventory(n,c),
      /STAGING_RUNTIME_BLOCKED/);
  }
});

test('effective Docker published ports match loopback staging frontend only',()=>{
  const c=fixture();
  assert.equal(validateStagingEffectivePorts(c),true);
  const result=validateStagingContainers(c,{sha,host});
  assert.equal(result.services,4);
  // EXPOSE without any host publication is legal for db, redis and backend.
  c.backend.NetworkSettings.Ports['3001/tcp']=[];
  assert.equal(validateStagingEffectivePorts(c),true);
});

test('staging rejects actual public, IPv6, external and sidecar host port exposure',()=>{
  const mutations=[
    c=>{c.frontend.NetworkSettings.Ports['80/tcp'][0].HostIp='0.0.0.0';},
    c=>{c.frontend.NetworkSettings.Ports['80/tcp'][0].HostIp='::';},
    c=>{c.frontend.NetworkSettings.Ports['80/tcp'][0].HostIp='';},
    c=>{c.frontend.NetworkSettings.Ports['80/tcp'][0].HostPort='80';},
    c=>{c.frontend.NetworkSettings.Ports['80/tcp'][0].HostPort='4184';},
    c=>{c.frontend.NetworkSettings.Ports['80/tcp'].push({HostIp:'::',HostPort:'4183'});},
    c=>{c.frontend.NetworkSettings.Ports['443/tcp']=[{HostIp:'0.0.0.0',HostPort:'443'}];},
    c=>{c.frontend.NetworkSettings.Ports['80/tcp']=null;},
    c=>{delete c.frontend.NetworkSettings.Ports['80/tcp'];},
    c=>{c.db.NetworkSettings.Ports['5432/tcp']=[{HostIp:'127.0.0.1',HostPort:'5432'}];},
    c=>{c.db.NetworkSettings.Ports['5432/tcp']=[{HostIp:'0.0.0.0',HostPort:'5432'}];},
    c=>{c.redis.NetworkSettings.Ports['6379/tcp']=[{HostIp:'::',HostPort:'6379'}];},
    c=>{c.backend.NetworkSettings.Ports['3001/tcp']=[{HostIp:'127.0.0.1',HostPort:'3001'}];},
    c=>{c.backend.NetworkSettings.Ports['3001/tcp']=[{HostIp:'0.0.0.0',HostPort:'3001'}];},
    c=>{c.db.NetworkSettings.Ports=undefined;},
    c=>{c.frontend.NetworkSettings.Ports=[];},
    c=>{c.frontend.NetworkSettings.Ports['80/tcp']='127.0.0.1:4183';},
    c=>{c.frontend.NetworkSettings.Ports['80/tcp']=[{HostIp:'127.0.0.1'}];},
    c=>{c.redis.NetworkSettings.Ports['bad-port']=null;}
  ];
  for (const mutate of mutations){
    const c=fixture();
    mutate(c);
    assert.throws(()=>validateStagingEffectivePorts(c),/STAGING_RUNTIME_BLOCKED/);
    assert.throws(()=>validateStagingContainers(c,{sha,host}),/STAGING_RUNTIME_BLOCKED/);
  }
});

test('signed OCI runtime rejects a published database port despite valid images and network',()=>{
  const c=fixture(), signed={backend:imageId('3'),frontend:imageId('4')};
  for (const [i,name] of ['db','redis','backend','frontend'].entries())
    c[name].Id=String(i+5).repeat(64);
  c.backend.Config.Image=signed.backend;
  c.frontend.Config.Image=signed.frontend;
  assert.equal(validateStagingContainers(c,{sha,host,signedImageIds:signed}).status,
    'RUNTIME_REVIEW_REQUIRED');
  c.redis.NetworkSettings.Ports['6379/tcp']=[{HostIp:'0.0.0.0',HostPort:'6379'}];
  assert.throws(()=>validateStagingContainers(c,{sha,host,signedImageIds:signed}),
    /STAGING_RUNTIME_BLOCKED/);
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


test('staging accepts private namespace Docker defaults and no-new-privileges only',()=>{
  const c=fixture();
  Object.assign(c.backend.HostConfig,{
    PidMode:'',IpcMode:'private',UTSMode:'',CgroupnsMode:'private',
    UsernsMode:'',CapAdd:[],Devices:null,DeviceRequests:[],
    Binds:[],ExtraHosts:null,Dns:[],DnsOptions:[],DnsSearch:[],
    SecurityOpt:['no-new-privileges:true'],CgroupParent:'',
    Sysctls:{},Tmpfs:{},PublishAllPorts:false
  });
  const report=validateStagingContainers(c,{sha,host});
  assert.equal(report.services,4);
  assert.equal(report.status,'RUNTIME_REVIEW_REQUIRED');
});

test('signed staging refuses host namespace escapes, injected DNS and privileged devices',()=>{
  const ids={backend:imageId('3'),frontend:imageId('4')};
  const signedFixture=()=>{
    const c=fixture();
    for(const [i,name] of ['db','redis','backend','frontend'].entries())
      c[name].Id=String(i+5).repeat(64);
    c.backend.Config.Image=ids.backend;
    c.frontend.Config.Image=ids.frontend;
    return c;
  };
  const attacks=[
    ['alternate Compose network mode',h=>{h.NetworkMode='foreign_private_net';}],
    ['host PID namespace',h=>{h.PidMode='host';}],
    ['host IPC namespace',h=>{h.IpcMode='host';}],
    ['host UTS namespace',h=>{h.UTSMode='host';}],
    ['host cgroup namespace',h=>{h.CgroupnsMode='host';}],
    ['host user namespace',h=>{h.UsernsMode='host';}],
    ['extra Linux capability',h=>{h.CapAdd=['SYS_ADMIN'];}],
    ['mapped host device',h=>{h.Devices=[{PathOnHost:'/dev/sda'}];}],
    ['GPU/device request',h=>{h.DeviceRequests=[{Driver:'nvidia',Count:1}];}],
    ['device group rule',h=>{h.DeviceCgroupRules=['a *:* rwm'];}],
    ['host volume bind',h=>{h.Binds=['/srv/production:/secrets:ro'];}],
    ['host gateway override',h=>{h.ExtraHosts=['db:host-gateway'];}],
    ['custom DNS resolver',h=>{h.Dns=['8.8.8.8'];}],
    ['custom DNS options',h=>{h.DnsOptions=['use-vc'];}],
    ['custom DNS search',h=>{h.DnsSearch=['production.internal'];}],
    ['legacy container link',h=>{h.Links=['production_db:db'];}],
    ['supplementary host group',h=>{h.GroupAdd=['docker'];}],
    ['CDI device injection',h=>{h.CdiDevices=['vendor.com/gpu=all'];}],
    ['unconfined seccomp',h=>{h.SecurityOpt=['seccomp=unconfined'];}],
    ['unconfined AppArmor',h=>{h.SecurityOpt=['apparmor=unconfined'];}],
    ['unexpected tmpfs',h=>{h.Tmpfs={'/etc':'rw'};}],
    ['custom sysctl',h=>{h.Sysctls={'net.ipv4.ip_forward':'1'};}],
    ['custom cgroup parent',h=>{h.CgroupParent='/docker/production';}],
    ['publish all image ports',h=>{h.PublishAllPorts=true;}],
    ['privileged process',h=>{h.Privileged=true;}]
  ];
  for(const [label,mutate] of attacks){
    const f=signedFixture();
    mutate(f.backend.HostConfig);
    assert.throws(()=>validateStagingContainers(f,{sha,host,signedImageIds:ids}),
      /STAGING_RUNTIME_BLOCKED/,label);
    const legacy=fixture();
    mutate(legacy.frontend.HostConfig);
    assert.throws(()=>validateStagingContainers(legacy,{sha,host}),
      /STAGING_RUNTIME_BLOCKED/,label+' legacy');
  }
});

test('signed OCI staging accepts ONLY exact backend/frontend immutable config IDs',()=>{
  const c=fixture(),expected={backend:imageId('3'),frontend:imageId('4')};
  for(const [i,name] of ['db','redis','backend','frontend'].entries()){
    c[name].Id=String(i+5).repeat(64);
  }
  c.backend.Config.Image=expected.backend;
  c.frontend.Config.Image=expected.frontend;
  const proof=validateStagingContainers(c,{sha,host,signedImageIds:expected});
  assert.equal(proof.status,'RUNTIME_REVIEW_REQUIRED');
  assert.equal(proof.image_reference_kind,'immutable-config-id');
  assert.deepEqual(proof.container_ids,{
    db:'5'.repeat(64),redis:'6'.repeat(64),
    backend:'7'.repeat(64),frontend:'8'.repeat(64)
  });
  assert.equal(proof.signed_provenance_certified,false,
    'shape validation alone must never claim real signature verification');
  assert.equal(proof.registry_digest_certified,false);
  assert.doesNotMatch(JSON.stringify(proof),/PRIVATE-NOT-IN-OUTPUT/);
  // Legacy mode may not accept sha256 Config.Image; never downgrade silently.
  assert.throws(()=>validateStagingContainers(c,{sha,host}),/STAGING_RUNTIME_BLOCKED/);
});

test('signed staging refuses mutable tags, alternative image IDs and replaced container identity',()=>{
  const ids={backend:imageId('3'),frontend:imageId('4')};
  const seeded=()=>{
    const c=fixture();
    for(const [i,name] of ['db','redis','backend','frontend'].entries()){
      c[name].Id=String(i+5).repeat(64);
    }
    c.backend.Config.Image=ids.backend;
    c.frontend.Config.Image=ids.frontend;
    return c;
  };
  for(const change of [
    c=>{c.backend.Config.Image='sedeagro-staging-backend:'+sha;},
    c=>{c.frontend.Config.Image='sedeagro-frontend-rc:'+sha;},
    c=>{c.backend.Config.Image=imageId('a');},
    c=>{c.frontend.Image=imageId('a');},
    c=>{c.backend.Config.Labels['org.opencontainers.image.revision']='b'.repeat(40);},
    c=>{c.backend.Id='invalid';},
    c=>{c.redis.Id=c.backend.Id;},
    c=>{c.frontend.HostConfig.PortBindings['80/tcp'][0].HostIp='0.0.0.0';},
    c=>{c.db.NetworkSettings.Networks={'production':{}};},
    c=>{c.redis.Mounts[0].Name='sedeagro_redis';},
    c=>{c.backend.State.Health.Status='unhealthy';},
    c=>{c.backend.Config.Env[0]='NODE_ENV=development';}
  ]){
    const c=seeded();change(c);
    assert.throws(()=>validateStagingContainers(c,{sha,host,signedImageIds:ids}),
      /STAGING_RUNTIME_BLOCKED/);
  }
  for(const invalid of [
    {backend:ids.backend,frontend:ids.backend},
    {backend:'backend:mutable',frontend:ids.frontend},
    {backend:ids.backend},
    {...ids,extra:ids.backend}
  ]){
    assert.throws(()=>validateStagingContainers(seeded(),{
      sha,host,signedImageIds:invalid
    }),/STAGING_RUNTIME_BLOCKED/);
  }
});

test('signed staging Docker inspector ties each container list ID to inspected full ID',()=>{
  const ids={backend:imageId('3'),frontend:imageId('4')},c=fixture();
  const byService={db:'5',redis:'6',backend:'7',frontend:'8'};
  for(const name of Object.keys(c)){
    c[name].Id=byService[name].repeat(64);
    if(ids[name])c[name].Config.Image=ids[name];
  }
  const volumes=volumeFixture(c);
  const privateNet=networkFixture(c);
  const baseImages=baseImageFixture(c);
  const execute=args=>{
    if(args[0]==='image'){
      assert.deepEqual(args.slice(0,4),['image','inspect','--format','{{json .}}']);
      const ref=args.at(-1);
      const name=ref===locked('postgis')?'db':ref===locked('redis')?'redis':null;
      assert.ok(name,'only pinned db/redis image inspect allowed');
      return JSON.stringify(baseImages[name]);
    }
    if(args[0]==='network'){
      assert.deepEqual(args,['network','inspect','--format','{{json .}}',network]);
      return JSON.stringify(privateNet);
    }
    if(args[0]==='volume') {
      assert.deepEqual(args.slice(0,3),['volume','inspect','--format']);
      const name=args.at(-1);
      return JSON.stringify(Object.values(volumes).find(v=>v.Name===name));
    }
    if(args[0]==='container'){
      if(args.includes('--no-trunc'))
        return Object.values(byService).map(x=>x.repeat(64)).join('\n')+'\n';
      const service=args.at(-1).split('=').at(-1);
      return byService[service].repeat(12)+'\n';
    }
    const containerId=args.at(-1);
    const service=Object.keys(byService).find(x=>
      byService[x].repeat(12)===containerId);
    return JSON.stringify(c[service]);
  };
  const ok=inspectStagingRuntime({sha,host,signedImageIds:ids,execute});
  assert.equal(ok.image_reference_kind,'immutable-config-id');
  assert.equal(ok.project_container_census_verified,true);
  assert.equal(ok.project_base_image_inventory_verified,true);
  assert.deepEqual(ok.project_base_image_ids,{db:imageId('1'),redis:imageId('2')});
  assert.equal(ok.project_volume_inventory_verified,true);
  assert.equal(ok.project_network_inventory_verified,true);
  assert.equal(ok.project_network_id,privateNet.Id);
  c.frontend.Id='9'.repeat(64);
  assert.throws(()=>inspectStagingRuntime({
    sha,host,signedImageIds:ids,execute
  }),/STAGING_RUNTIME_BLOCKED/);
  let used=false;
  assert.throws(()=>inspectStagingRuntime({
    sha,host,signedImageIds:{backend:ids.backend,frontend:ids.backend},
    execute:()=>{used=true;return '{}';}
  }),/STAGING_RUNTIME_BLOCKED/);
  assert.equal(used,false);
});


test('signed staging rejects orphan, missing, duplicate or replaced project container census',()=>{
  const ids={backend:imageId('3'),frontend:imageId('4')},
    c=fixture(),names=['db','redis','backend','frontend'];
  const byService={db:'5',redis:'6',backend:'7',frontend:'8'};
  for(const name of names){
    c[name].Id=byService[name].repeat(64);
    if(ids[name])c[name].Config.Image=ids[name];
  }
  const exact=names.map(name=>c[name].Id);
  for(const projectIds of [
    [...exact,'9'.repeat(64)],   // malicious fifth or prior orphan service
    exact.slice(0,3),            // missing known project member
    [exact[0],exact[1],exact[2],exact[2]], // duplicated list
    [exact[0],exact[1],exact[2],'f'.repeat(64)], // swapped image container
    [exact[0],exact[1],exact[2],'malformed'],
    []
  ]){
    let censusCalls=0;
    const execute=args=>{
      if(args[0]==='container'){
        if(args.includes('--no-trunc')){
          censusCalls++;
          assert.ok(args.includes(
            'label=com.docker.compose.project=sedeagro-staging'));
          assert.ok(!args.some(x=>/prod\\.env|sedeagro\\.fedes\\.ai/.test(x)));
          return projectIds.join('\n')+(projectIds.length?'\n':'');
        }
        const service=args.at(-1).split('=').at(-1);
        return byService[service].repeat(12)+'\n';
      }
      const service=names.find(name=>byService[name].repeat(12)===args.at(-1));
      return JSON.stringify(c[service]);
    };
    assert.throws(()=>inspectStagingRuntime({sha,host,signedImageIds:ids,execute}),
      /STAGING_RUNTIME_BLOCKED/);
    assert.equal(censusCalls,1,'whole project must be inventoried independently');
  }
});
