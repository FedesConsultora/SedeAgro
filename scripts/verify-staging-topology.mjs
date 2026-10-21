// 0P.22: fail-closed check of Docker Compose's RESOLVED staging topology.
// Run with: docker compose --env-file /dev/null -f docker-compose.staging.yml
//            config --format json | node scripts/verify-staging-topology.mjs --sha SHA --host HOST
// IMPORTANT: resolved Compose JSON contains secrets. Never echo or persist it.
import { readFileSync } from 'node:fs';
import { validateBaseImageLock } from './verify-base-image-pins.mjs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const BASE_REFS = validateBaseImageLock(JSON.parse(readFileSync(new URL('./base-image-lock.json', import.meta.url), 'utf8')));
const SHA = /^[a-f0-9]{40}$/;
const HOST = /^staging[.-][a-z0-9][a-z0-9.-]*[a-z0-9]$/;
const SERVICES = ['db', 'redis', 'backend', 'frontend'];
const NETWORK = 'sedeagro-staging_staging_internal';
const PROJECT = 'sedeagro-staging';

function block(reason) {
  throw new Error('STAGING_TOPOLOGY_BLOCKED: ' + reason);
}
function credentials(value, minimum) {
  return typeof value === 'string' && value.length >= minimum &&
    /^[a-zA-Z0-9._~-]+$/.test(value) &&
    !/replace|change|demo|example|password|secret|testing/i.test(value);
}
function singleNetwork(service) {
  return service?.networks && typeof service.networks === 'object' &&
    !Array.isArray(service.networks) &&
    Object.keys(service.networks).length === 1 &&
    Object.hasOwn(service.networks, 'staging_internal');
}
function volumeIs(service, namedVolume, target) {
  const mounts = service?.volumes;
  return Array.isArray(mounts) && mounts.length === 1 &&
    mounts[0]?.type === 'volume' && mounts[0]?.source === namedVolume &&
    mounts[0]?.target === target && mounts[0]?.read_only !== true;
}

export function validateStagingHost(host) {
  if (typeof host !== 'string' || host.length > 160 ||
      !HOST.test(host) || host.includes('..') ||
      /(?:^|\.)(?:localhost|local|internal|invalid)$/.test(host) ||
      host === 'sedeagro.fedes.ai') block('invalid staging hostname');
  return host;
}

export function validateStagingTopology(config, { sha, host } = {}) {
  if (!SHA.test(sha || '')) block('exact commit SHA required');
  validateStagingHost(host);
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      config.name !== PROJECT || !config.services ||
      Object.keys(config.services).sort().join(',') !== [...SERVICES].sort().join(',') ||
      !config.networks ||
      Object.keys(config.networks).join(',') !== 'staging_internal' ||
      config.networks.staging_internal?.name !== NETWORK ||
      config.networks.staging_internal?.internal !== true ||
      config.networks.staging_internal?.external === true ||
      !config.volumes ||
      Object.keys(config.volumes).sort().join(',') !== ['staging_pgdata', 'staging_redisdata'].sort().join(',')) {
    block('project, network, service or volume isolation mismatch');
  }
  for (const [key, suffix] of [['staging_pgdata','staging_pgdata'],['staging_redisdata','staging_redisdata']]) {
    const v = config.volumes[key];
    if (v?.name !== PROJECT + '_' + suffix || v?.external === true) block('unsafe staging volume');
  }
  for (const name of SERVICES) {
    const svc = config.services[name];
    if (!singleNetwork(svc) || svc.container_name !== undefined || svc.privileged === true ||
        svc.network_mode !== undefined || svc.pid !== undefined ||
        svc.links !== undefined || svc.env_file !== undefined ||
        svc.extra_hosts !== undefined || svc.restart !== 'unless-stopped' ||
        !Array.isArray(svc.healthcheck?.test) || svc.healthcheck.test.length < 2) {
      block('unsafe service isolation or missing healthcheck');
    }
    if (name !== 'frontend' && Array.isArray(svc.ports) && svc.ports.length) {
      block('non-frontend service exposed on host');
    }
    if (name !== 'frontend' && svc.ports && !Array.isArray(svc.ports)) block('unsafe host port');
    if (['backend','frontend'].includes(name) && Array.isArray(svc.volumes) && svc.volumes.length) {
      block('application host mounts forbidden');
    }
  }

  const { db, redis, backend, frontend } = config.services;
  if (db.image !== BASE_REFS.postgis ||
      redis.image !== BASE_REFS.redis ||
      db.environment?.POSTGRES_DB !== 'sedeagro_staging' ||
      db.environment?.POSTGRES_USER !== 'sedeagro_staging_owner' ||
      !credentials(db.environment?.POSTGRES_PASSWORD, 24) ||
      !volumeIs(db, 'staging_pgdata', '/var/lib/postgresql/data') ||
      !volumeIs(redis, 'staging_redisdata', '/data')) {
    block('staging database or Redis isolation mismatch');
  }
  if (backend.image !== 'sedeagro-staging-backend:' + sha ||
      frontend.image !== 'sedeagro-staging-frontend:' + sha ||
      backend.build?.target !== 'prod' ||
      frontend.build?.target !== 'prod' ||
      backend.build?.args?.RELEASE_SHA !== sha ||
      frontend.build?.args?.RELEASE_SHA !== sha ||
      frontend.build?.args?.VITE_API_URL !== '/api' ||
      !String(backend.build?.context || '').endsWith('/backend') ||
      !String(frontend.build?.context || '').endsWith('/frontend')) {
    block('staging images not bound to the exact release source');
  }
  const env = backend.environment;
  if (env?.NODE_ENV !== 'production' || env?.SEED_MODE !== 'prod' ||
      env?.LOG_SQL !== '0' || env?.LOG_STACK !== '0' ||
      env?.BASE_DOMAIN !== host || env?.CORS_ORIGIN !== 'https://' + host ||
      env?.REDIS_URL !== 'redis://redis:6379' ||
      !credentials(env?.JWT_SECRET, 32)) {
    block('staging backend origin, security, or JWT isolation mismatch');
  }
  let dbUrl;
  try { dbUrl = new URL(env.DATABASE_URL); } catch { block('invalid staging runtime DB connection'); }
  if (dbUrl.protocol !== 'postgres:' ||
      dbUrl.username !== 'sedeagro_staging_app' || dbUrl.hostname !== 'db' ||
      dbUrl.port !== '5432' || dbUrl.pathname !== '/sedeagro_staging' ||
      dbUrl.search || dbUrl.hash || !credentials(dbUrl.password, 24) ||
      new Set([db.environment.POSTGRES_PASSWORD, dbUrl.password, env.JWT_SECRET]).size !== 3) {
    block('staging DB runtime role, credentials or destination mismatch');
  }

  if (!backend.networks.staging_internal?.aliases?.includes('sedeagro_backend') ||
      backend.depends_on?.db?.condition !== 'service_healthy' ||
      backend.depends_on?.redis?.condition !== 'service_healthy' ||
      frontend.depends_on?.backend?.condition !== 'service_healthy' ||
      !Array.isArray(frontend.ports) || frontend.ports.length !== 1 ||
      frontend.ports[0].host_ip !== '127.0.0.1' ||
      String(frontend.ports[0].published) !== '4183' ||
      Number(frontend.ports[0].target) !== 80 ||
      (frontend.ports[0].protocol && frontend.ports[0].protocol !== 'tcp')) {
    block('staging internal proxy route or loopback-only port invalid');
  }
  return {
    status: 'CONFIG_REVIEW_REQUIRED',
    project: PROJECT,
    release_sha: sha,
    host,
    services: SERVICES.length,
    network: NETWORK,
    loopback_port: 4183,
    runtime_certified: false
  };
}

async function main() {
  if (process.argv.length !== 6 ||
      process.argv[2] !== '--sha' || process.argv[4] !== '--host') block('invalid arguments');
  let bytes = 0, input = '';
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 262144) block('oversized resolved staging configuration');
    input += chunk.toString('utf8');
  }
  const result = validateStagingTopology(JSON.parse(input), {
    sha: process.argv[3], host: process.argv[5]
  });
  console.log(JSON.stringify(result));
  console.log('PENDING: operator-approved TLS staging, runtime OCI identity and real DB/RLS/backup acceptance.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    // Compose configuration contains private JWT and DB passwords; NEVER echo errors.
    console.error('BLOCKED staging topology: invalid or unsafe resolved configuration');
    process.exitCode = 2;
  });
}
