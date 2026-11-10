// 0P.22: READ-ONLY inspection of containers actually running under the
// isolated Compose project. Never runs compose up/down, exec, or prints Env.
import { readFileSync } from 'node:fs';
import { validateBaseImageLock } from './verify-base-image-pins.mjs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { validateStagingHost } from './verify-staging-topology.mjs';

const BASE_REFS = validateBaseImageLock(JSON.parse(readFileSync(new URL('./base-image-lock.json', import.meta.url), 'utf8')));
const PROJECT = 'sedeagro-staging';
const NETWORK = 'sedeagro-staging_staging_internal';
const SHA = /^[a-f0-9]{40}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const CONTAINER_ID = /^[a-f0-9]{12,64}$/;
const SERVICES = ['db','redis','backend','frontend'];

const defaultExecute = (args) => execFileSync('docker', args, {
  encoding: 'utf8', timeout: 12000, maxBuffer: 512 * 1024,
  stdio: ['ignore','pipe','pipe'],
  // Never inherit a remote daemon from the operator's process environment.
  env: { PATH: process.env.PATH, HOME: process.env.HOME }
});

function assert(ok) {
  if (!ok) throw new Error('STAGING_RUNTIME_BLOCKED');
}
function envValues(list) {
  assert(Array.isArray(list) && list.length < 100);
  const env = Object.create(null);
  for (const entry of list) {
    assert(typeof entry === 'string' && entry.includes('='));
    const index = entry.indexOf('='), name = entry.slice(0,index);
    assert(!Object.hasOwn(env,name));
    env[name] = entry.slice(index+1);
  }
  return env;
}

export function validateStagingContainers(containers, { sha, host, signedImageIds } = {}) {
  assert(SHA.test(sha || ''));
  validateStagingHost(host);
  const immutable = signedImageIds !== undefined;
  // This is only a shape/identity validator, not a signature checker.
  // The operator CLI must obtain these values from signed human + OCI proof.
  if (immutable) {
    assert(signedImageIds && typeof signedImageIds === 'object' &&
      !Array.isArray(signedImageIds) &&
      Object.keys(signedImageIds).sort().join(',') === 'backend,frontend' &&
      IMAGE_ID.test(signedImageIds.backend) &&
      IMAGE_ID.test(signedImageIds.frontend) &&
      signedImageIds.backend !== signedImageIds.frontend);
  }
  assert(containers && typeof containers === 'object' &&
    Object.keys(containers).sort().join(',') === SERVICES.slice().sort().join(','));
  const images = {}, containerIds = {};
  for (const name of SERVICES) {
    const c = containers[name];
    assert(c && c.Config && c.HostConfig && c.State &&
      c.NetworkSettings && Array.isArray(c.Mounts));
    const labels = c.Config.Labels || {};
    assert(labels['com.docker.compose.project'] === PROJECT &&
      labels['com.docker.compose.service'] === name);
    assert(c.State.Running === true && c.State.Status === 'running' &&
      c.State.Health?.Status === 'healthy' && c.RestartCount === 0 &&
      IMAGE_ID.test(c.Image));
    const nets = Object.keys(c.NetworkSettings.Networks || {});
    assert(nets.length === 1 && nets[0] === NETWORK &&
      c.HostConfig.Privileged !== true &&
      !c.HostConfig.NetworkMode?.startsWith('host'));
    const bindings = c.HostConfig.PortBindings || {};
    if (name === 'frontend') {
      assert(Object.keys(bindings).length === 1 &&
        Array.isArray(bindings['80/tcp']) && bindings['80/tcp'].length === 1 &&
        bindings['80/tcp'][0].HostIp === '127.0.0.1' &&
        bindings['80/tcp'][0].HostPort === '4183');
    } else {
      assert(Object.keys(bindings).length === 0);
    }
    if (name === 'db' || name === 'redis') {
      assert(c.Mounts.length === 1 &&
        c.Mounts[0].Type === 'volume' &&
        c.Mounts[0].Name === PROJECT + '_' +
          (name === 'db' ? 'staging_pgdata' : 'staging_redisdata'));
    } else {
      assert(c.Mounts.length === 0);
    }

    if (name === 'backend' || name === 'frontend') {
      const reference = immutable ? signedImageIds[name] :
        'sedeagro-staging-' + name + ':' + sha;
      // In immutable mode Docker must have actually created this container
      // using the exact config ID, not a mutable tag with the same revision.
      assert(c.Config.Image === reference && c.Image ===
        (immutable ? reference : c.Image) &&
        labels['org.opencontainers.image.revision'] === sha);
    } else {
      assert(c.Config.Image === (name === 'db' ? BASE_REFS.postgis : BASE_REFS.redis));
    }
    if (name === 'backend') {
      const env = envValues(c.Config.Env);
      assert(env.NODE_ENV === 'production' && env.SEED_MODE === 'prod' &&
        env.BASE_DOMAIN === host && env.CORS_ORIGIN === 'https://' + host &&
        env.SEDEAGRO_BUILD_SHA === sha && env.LOG_SQL === '0' &&
        env.LOG_STACK === '0');
      let url;
      try { url = new URL(env.DATABASE_URL); } catch { assert(false); }
      assert(url.hostname === 'db' && url.port === '5432' &&
        url.pathname === '/sedeagro_staging' && url.username === 'sedeagro_staging_app');
    }
    images[name] = c.Image; // LOCAL Docker image ID; not a registry digest attestation.
    if (immutable) {
      assert(typeof c.Id === 'string' && /^[a-f0-9]{64}$/.test(c.Id));
      containerIds[name] = c.Id;
    }
  }
  if (immutable) assert(new Set(Object.values(containerIds)).size === SERVICES.length);
  return {
    status: 'RUNTIME_REVIEW_REQUIRED',
    project: PROJECT, release_sha: sha, host,
    services: SERVICES.length, network: NETWORK,
    image_ids: images, image_reference_kind: immutable ? 'immutable-config-id' : 'legacy-staging-tag',
    ...(immutable ? { container_ids: containerIds } : {}),
    signed_provenance_certified: false, registry_digest_certified: false,
    tls_certified: false, database_isolation_certified: false
  };
}

export function inspectStagingRuntime({ sha, host, signedImageIds, execute = defaultExecute } = {}) {
  assert(SHA.test(sha || ''));
  validateStagingHost(host);
  const immutable = signedImageIds !== undefined;
  if (immutable) {
    assert(signedImageIds && Object.keys(signedImageIds).sort().join(',') === 'backend,frontend' &&
      IMAGE_ID.test(signedImageIds.backend) && IMAGE_ID.test(signedImageIds.frontend) &&
      signedImageIds.backend !== signedImageIds.frontend);
  }
  const containers = {};
  for (const name of SERVICES) {
    // Docker label filters locate by exact project + service. Never inspect the
    // production project or an arbitrary user-provided container ID.
    const output = execute(['container','ls','--all','--quiet',
      '--filter','label=com.docker.compose.project=' + PROJECT,
      '--filter','label=com.docker.compose.service=' + name]);
    const ids = String(output).trim().split(/\s+/).filter(Boolean);
    assert(ids.length === 1 && CONTAINER_ID.test(ids[0]));
    const raw = execute(['inspect','--type=container','--format','{{json .}}',ids[0]]);
    assert(typeof raw === 'string' && raw.length < 512 * 1024);
    containers[name] = JSON.parse(raw);
    // Double-check Docker listed exactly the same container we inspected.
    if (immutable) assert(typeof containers[name]?.Id === 'string' &&
      containers[name].Id.startsWith(ids[0]));
  }
  return validateStagingContainers(containers,{sha,host,signedImageIds});
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert(process.argv.length === 6 &&
      process.argv[2] === '--sha' && process.argv[4] === '--host');
    const result = inspectStagingRuntime({sha:process.argv[3],host:process.argv[5]});
    console.log(JSON.stringify(result));
    console.log('NOT CERTIFIED: public HTTPS TLS/CI artifact digests, staging data and device acceptance.');
  } catch {
    // Docker errors and inspect JSON may contain environment secrets; redact all.
    console.error('BLOCKED staging runtime: missing, unhealthy, mixed or unidentified containers');
    process.exitCode = 2;
  }
}
