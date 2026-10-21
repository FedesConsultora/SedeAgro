import test from 'node:test';
import { readFileSync } from 'node:fs';
const baseLock = JSON.parse(readFileSync(new URL('../base-image-lock.json', import.meta.url), 'utf8'));
const locked = key => baseLock.images[key].tag + '@' + baseLock.images[key].digest;

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateStagingHost, validateStagingTopology } from '../verify-staging-topology.mjs';

const sha = 'a'.repeat(40);
const host = 'staging.ci.test';
const network = { staging_internal: {} };
const healthy = { test:['CMD','true'] };
const baseService = () => ({
  restart:'unless-stopped',networks:structuredClone(network),
  healthcheck:structuredClone(healthy)
});
function config() {
  const db = baseService();
  Object.assign(db,{
    image:locked('postgis'),
    environment:{
      POSTGRES_DB:'sedeagro_staging',
      POSTGRES_USER:'sedeagro_staging_owner',
      POSTGRES_PASSWORD:'p'.repeat(40)
    },
    volumes:[{type:'volume',source:'staging_pgdata',target:'/var/lib/postgresql/data'}]
  });
  const redis=baseService();
  Object.assign(redis,{
    image:locked('redis'),
    volumes:[{type:'volume',source:'staging_redisdata',target:'/data'}]
  });
  const backend=baseService();
  Object.assign(backend,{
    image:'sedeagro-staging-backend:'+sha,
    build:{context:'/work/backend',target:'prod',args:{RELEASE_SHA:sha}},
    networks:{staging_internal:{aliases:['sedeagro_backend']}},
    depends_on:{db:{condition:'service_healthy'},redis:{condition:'service_healthy'}},
    environment:{
      NODE_ENV:'production',SEED_MODE:'prod',LOG_SQL:'0',LOG_STACK:'0',
      BASE_DOMAIN:host,CORS_ORIGIN:'https://'+host,
      REDIS_URL:'redis://redis:6379',
      JWT_SECRET:'j'.repeat(42),
      DATABASE_URL:'postgres://sedeagro_staging_app:'+'q'.repeat(36)+'@db:5432/sedeagro_staging'
    }
  });
  const frontend=baseService();
  Object.assign(frontend,{
    image:'sedeagro-staging-frontend:'+sha,
    build:{context:'/work/frontend',target:'prod',args:{RELEASE_SHA:sha,VITE_API_URL:'/api'}},
    depends_on:{backend:{condition:'service_healthy'}},
    ports:[{target:80,published:'4183',host_ip:'127.0.0.1',protocol:'tcp'}]
  });
  return {
    name:'sedeagro-staging',
    services:{db,redis,backend,frontend},
    networks:{staging_internal:{name:'sedeagro-staging_staging_internal',internal:true}},
    volumes:{
      staging_pgdata:{name:'sedeagro-staging_staging_pgdata'},
      staging_redisdata:{name:'sedeagro-staging_staging_redisdata'}
    }
  };
}

test('minimal resolved staging config is accepted only for operator review',()=>{
  const result=validateStagingTopology(config(),{sha,host});
  assert.equal(result.status,'CONFIG_REVIEW_REQUIRED');
  assert.equal(result.project,'sedeagro-staging');
  assert.equal(result.runtime_certified,false);
  assert.equal(result.loopback_port,4183);
  assert.equal(JSON.stringify(result).includes('postgres://'),false);
});

test('invalid host, production domain, unsafe scheme and shortened SHA are refused',()=>{
  for(const invalid of ['sedeagro.fedes.ai','production.example.com',
    'staging.localhost','staging.local','staging.invalid','https://staging.ci.test',
    'staging.ci.test/path','staging..ci.test','localhost','staging-']){
    assert.throws(()=>validateStagingHost(invalid),/BLOCKED/,invalid);
  }
  assert.throws(()=>validateStagingTopology(config(),{sha:'abcd',host}),/BLOCKED/);
});

test('never silently joins shared production network or reuses fixed container names',()=>{
  const mutations = [
    c=>{c.name='sedeagro';},
    c=>{c.networks.staging_internal.name='sedeagro_internal';},
    c=>{c.networks.staging_internal.internal=false;},
    c=>{c.networks['fedes-net']={external:true};},
    c=>{c.services.frontend.networks['fedes-net']={};},
    c=>{c.services.backend.container_name='sedeagro_backend';},
    c=>{c.services.db.container_name='sedeagro_db';},
    c=>{c.services.backend.network_mode='host';},
    c=>{c.services.frontend.privileged=true;},
    c=>{c.services.backend.env_file=['./backend/.env'];},
    c=>{c.volumes.staging_pgdata.name='sedeagro_db';},
    c=>{c.services.db.volumes[0].source='sedeagro_db';},
    c=>{c.services.backend.ports=[{target:3001,published:'3001',host_ip:'0.0.0.0'}];},
    c=>{c.services.db.ports=[{target:5432,published:'5432',host_ip:'127.0.0.1'}];},
    c=>{c.services.frontend.ports[0].host_ip='0.0.0.0';},
    c=>{c.services.frontend.ports[0].published='80';},
    c=>{c.services.frontend.ports.push({target:81,published:'4184',host_ip:'127.0.0.1'});},
    c=>{c.services.frontend.healthcheck.test=[];}
  ];
  for(const mutate of mutations){
    const c=config();mutate(c);
    assert.throws(()=>validateStagingTopology(c,{sha,host}),/BLOCKED/,
      'unsafe topology must fail closed: '+mutate.toString());
  }
});

test('staging topology refuses mutable tag and unauthorized same-length registry digest',()=>{
  for(const [service,key] of [['db','postgis'],['redis','redis']]){
    const baseline=locked(key);
    for(const value of [baseLock.images[key].tag,
      baseLock.images[key].tag+'@sha256:'+'f'.repeat(64)]) {
      const c=config(); c.services[service].image=value;
      assert.notEqual(value,baseline);
      assert.throws(()=>validateStagingTopology(c,{sha,host}),/BLOCKED/);
    }
  }
});

test('backend release and runtime DB role must not target production',()=>{
  const mutations = [
    c=>{c.services.backend.image='sedeagro-backend:'+sha;},
    c=>{c.services.frontend.build.args.RELEASE_SHA='b'.repeat(40);},
    c=>{c.services.backend.build.args.RELEASE_SHA='b'.repeat(40);},
    c=>{c.services.backend.build.target='dev';},
    c=>{c.services.frontend.build.args.VITE_API_URL='https://other.invalid/api';},
    c=>{c.services.backend.environment.BASE_DOMAIN='sedeagro.fedes.ai';},
    c=>{c.services.backend.environment.CORS_ORIGIN='https://sedeagro.fedes.ai';},
    c=>{c.services.backend.environment.SEED_MODE='demo';},
    c=>{c.services.backend.environment.LOG_SQL='1';},
    c=>{c.services.backend.environment.JWT_SECRET='short';},
    c=>{c.services.backend.environment.DATABASE_URL='postgres://sedeagro_staging_owner:'+'q'.repeat(36)+'@db:5432/sedeagro_staging';},
    c=>{c.services.backend.environment.DATABASE_URL='postgres://sedeagro_staging_app:'+'q'.repeat(36)+'@production:5432/sedeagro';},
    c=>{c.services.db.environment.POSTGRES_DB='sedeagro';},
    c=>{c.services.db.environment.POSTGRES_PASSWORD='p';},
    c=>{c.services.backend.environment.JWT_SECRET=c.services.db.environment.POSTGRES_PASSWORD;},
    c=>{delete c.services.backend.depends_on.db;},
    c=>{c.services.backend.networks.staging_internal.aliases=[];}
  ];
  for(const mutate of mutations){
    const c=config();mutate(c);
    assert.throws(()=>validateStagingTopology(c,{sha,host}),/BLOCKED/,
      'unsafe runtime config must fail closed: '+mutate.toString());
  }
});

test('CLI never exposes resolved Compose JSON or passwords even when malformed',()=>{
  const filename=fileURLToPath(new URL('../verify-staging-topology.mjs',import.meta.url));
  const c=config();
  c.services.backend.environment.JWT_SECRET='PRIVATE-NEVER-PRINT-'+ 'j'.repeat(35);
  c.name='sedeagro';
  const result=spawnSync(process.execPath,[filename,'--sha',sha,'--host',host],{
    input:JSON.stringify(c),encoding:'utf8',timeout:3000
  });
  assert.equal(result.status,2);
  assert.doesNotMatch(result.stdout+result.stderr,/PRIVATE-NEVER-PRINT|postgres:\/\//);
  assert.match(result.stderr,/BLOCKED staging topology/);
  const okay=spawnSync(process.execPath,[filename,'--sha',sha,'--host',host],{
    input:JSON.stringify(config()),encoding:'utf8',timeout:3000
  });
  assert.equal(okay.status,0,okay.stderr);
  assert.match(okay.stdout,/CONFIG_REVIEW_REQUIRED/);
});

test('deny oversized untrusted normalized config before parsing',()=>{
  const filename=fileURLToPath(new URL('../verify-staging-topology.mjs',import.meta.url));
  const r=spawnSync(process.execPath,[filename,'--sha',sha,'--host',host],{
    input:'x'.repeat(300000),encoding:'utf8',timeout:3000
  });
  assert.equal(r.status,2);
  assert.match(r.stderr,/BLOCKED staging topology/);
});
