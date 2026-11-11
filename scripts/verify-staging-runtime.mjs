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
// Docker's .Mounts and NetworkSettings alone cannot detect elevated host
// access: a container can have privileged host namespaces, extra devices,
// redirected name resolution or additional capabilities while still looking
// healthy on its expected Compose network. Reject such staging drift before
// accepting ANY of the four runtime identities.
function validateHostIsolation(hostConfig) {
  assert(hostConfig && hostConfig.Privileged === false &&
    hostConfig.NetworkMode === NETWORK &&
    hostConfig.PublishAllPorts !== true);

  const emptyList = value => value == null ||
    (Array.isArray(value) && value.length === 0);
  const privateMode = value => value == null ||
    value === '' || value === 'private';
  // No extra privileges, host aliases, manual DNS, host-volume shortcuts,
  // devices, supplementary groups or custom cgroup device permissions.
  for (const field of [
    'CapAdd', 'Devices', 'DeviceRequests', 'DeviceCgroupRules',
    'Binds', 'ExtraHosts', 'Dns', 'DnsOptions', 'DnsSearch', 'Links',
    'GroupAdd', 'CdiDevices'
  ]) assert(emptyList(hostConfig[field]));
  // Even when .Mounts looks harmless, tmpfs and host cgroup settings must
  // not be silently accepted as part of the signed staging baseline.
  assert(hostConfig.Tmpfs == null ||
    (typeof hostConfig.Tmpfs === 'object' &&
      !Array.isArray(hostConfig.Tmpfs) &&
      Object.keys(hostConfig.Tmpfs).length === 0));
  assert(hostConfig.Sysctls == null ||
    (typeof hostConfig.Sysctls === 'object' &&
      !Array.isArray(hostConfig.Sysctls) &&
      Object.keys(hostConfig.Sysctls).length === 0));
  assert(hostConfig.CgroupParent == null || hostConfig.CgroupParent === '');
  for (const field of [
    'PidMode', 'IpcMode', 'UTSMode', 'CgroupnsMode', 'UsernsMode'
  ]) assert(privateMode(hostConfig[field]));
  // Docker permits "no-new-privileges", a hardening-only security option.
  // Reject AppArmor/Seccomp overrides and unconfined flags.
  const security = hostConfig.SecurityOpt;
  assert(security == null || (Array.isArray(security) &&
    security.every(flag => flag === 'no-new-privileges' ||
      flag === 'no-new-privileges:true')));
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

// A Docker container's Mounts.Name alone does not attest the backing volume.
// Inspect the two Compose-owned local volumes independently: local driver,
// Compose project identity and expected Docker-managed path (rootful/rootless).
// Never print Mountpoint or Docker's raw inspect data.
export function validateStagingVolumeInventory(volumes, containers) {
  assert(volumes && typeof volumes === 'object' && !Array.isArray(volumes) &&
    Object.keys(volumes).sort().join(',') === 'db,redis');
  const expected = {
    db: {name: PROJECT + '_staging_pgdata', label:'staging_pgdata',
      destination:'/var/lib/postgresql/data'},
    redis: {name: PROJECT + '_staging_redisdata', label:'staging_redisdata',
      destination:'/data'}
  };
  const paths = [];
  for (const name of ['db','redis']) {
    const spec = expected[name], v = volumes[name];
    assert(v && typeof v === 'object' && !Array.isArray(v) &&
      v.Name === spec.name && v.Driver === 'local' &&
      v.Scope === 'local' &&
      v.Labels && v.Labels['com.docker.compose.project'] === PROJECT &&
      v.Labels['com.docker.compose.volume'] === spec.label &&
      (v.Options == null ||
        (typeof v.Options === 'object' && !Array.isArray(v.Options) &&
          Object.keys(v.Options).length === 0)));
    const root = v.Mountpoint;
    assert(typeof root === 'string' && root.startsWith('/') &&
      !root.includes('\\') && !root.includes('//') && !root.includes(String.fromCharCode(0)) &&
      !root.split('/').some(part => part === '.' || part === '..') &&
      root.endsWith('/volumes/' + spec.name + '/_data'));
    const mount = containers?.[name]?.Mounts?.[0];
    assert(mount && containers[name].Mounts.length === 1 &&
      mount.Type === 'volume' && mount.Name === spec.name &&
      mount.Driver === 'local' && mount.Source === root &&
      mount.Destination === spec.destination && mount.RW === true &&
      (mount.Propagation == null || mount.Propagation === ''));
    paths.push(root);
  }
  assert(new Set(paths).size === paths.length);
  return true;
}

// A container can name the expected network while its Docker network object
// is externally reachable, attachable or shared with another project.
// Check the independently inspected network object and the exact four live
// endpoints. Read-only: never create, connect, disconnect or prune networks.
export function validateStagingNetworkInventory(net, containers) {
  const HEX64 = /^[a-f0-9]{64}$/;
  assert(net && typeof net === 'object' && !Array.isArray(net) &&
    net.Name === NETWORK && HEX64.test(net.Id || '') &&
    net.Driver === 'bridge' && net.Scope === 'local' &&
    net.Internal === true && net.Attachable === false &&
    net.Ingress === false && net.ConfigOnly !== true &&
    net.Labels && net.Labels['com.docker.compose.project'] === PROJECT &&
    net.Labels['com.docker.compose.network'] === 'staging_internal' &&
    (net.Options == null ||
      (typeof net.Options === 'object' && !Array.isArray(net.Options) &&
        Object.keys(net.Options).length === 0)));
  const endpoints = net.Containers;
  assert(endpoints && typeof endpoints === 'object' &&
    !Array.isArray(endpoints) &&
    Object.keys(endpoints).length === SERVICES.length);
  const seenEndpoints = new Set();
  for (const name of SERVICES) {
    const c = containers?.[name], member = endpoints?.[c?.Id];
    const attached = c?.NetworkSettings?.Networks?.[NETWORK];
    const expectedName = c?.Name;
    assert(c && HEX64.test(c.Id || '') &&
      typeof expectedName === 'string' && /^\/[a-z0-9_-]+$/.test(expectedName) &&
      member && typeof member === 'object' &&
      member.Name === expectedName.slice(1) &&
      attached && attached.NetworkID === net.Id &&
      HEX64.test(attached.EndpointID || '') &&
      member.EndpointID === attached.EndpointID &&
      !seenEndpoints.has(attached.EndpointID));
    seenEndpoints.add(attached.EndpointID);
  }
  assert(Object.keys(endpoints).every(id =>
    SERVICES.some(name => containers[name].Id === id)));
  return net.Id;
}

// HostConfig.PortBindings describes requested bindings; NetworkSettings.Ports
// reports what Docker ACTUALLY published. Both must agree. Containers often
// have EXPOSE-d ports represented by null, which are not host publications.
export function validateStagingEffectivePorts(containers) {
  assert(containers && typeof containers === 'object' && !Array.isArray(containers));
  for (const name of SERVICES) {
    const c = containers[name];
    const bindings = c?.NetworkSettings?.Ports;
    assert(bindings && typeof bindings === 'object' &&
      !Array.isArray(bindings));
    let mapped = 0;
    for (const [key, value] of Object.entries(bindings)) {
      assert(/^[1-9][0-9]{0,4}\/(?:tcp|udp)$/.test(key) &&
        Number(key.split('/')[0]) <= 65535);
      if (value == null) continue; // Docker's unbound EXPOSE-only port.
      assert(Array.isArray(value));
      if (value.length === 0) continue; // Also no host publication.
      assert(name === 'frontend' && key === '80/tcp' &&
        value.length === 1 && value[0] &&
        typeof value[0] === 'object' &&
        !Array.isArray(value[0]) &&
        value[0].HostIp === '127.0.0.1' &&
        value[0].HostPort === '4183');
      mapped++;
    }
    assert(name === 'frontend' ?
      mapped === 1 && Object.hasOwn(bindings,'80/tcp') :
      mapped === 0);
  }
  return true;
}

// Config.Image only tells us the pull reference passed when a container was
// CREATED. A reused/stale local image may not be the locked upstream digest.
// Signed staging checks Docker's independent image-store record for the two
// third-party services and ties it to the actual running container Image ID.
// This does NOT assert signatures from Docker; provenance remains a separate gate.
export function validateStagingBaseImageInventory(images, containers) {
  assert(images && typeof images === 'object' && !Array.isArray(images) &&
    Object.keys(images).sort().join(',') === 'db,redis');
  const ids = {};
  for (const [name,lock] of [
    ['db',BASE_REFS.postgis],['redis',BASE_REFS.redis]
  ]) {
    const image = images[name], container = containers?.[name];
    const at = lock.lastIndexOf('@');
    assert(at > 0 && IMAGE_ID.test(lock.slice(at + 1)));
    const digest = lock.slice(at + 1);
    const registryName = lock.slice(0,at).replace(/:[^/:]+$/, '');
    const acceptedNames = name === 'redis' ?
      ['redis','docker.io/library/redis'] :
      ['postgis/postgis','docker.io/postgis/postgis'];
    assert(acceptedNames.includes(registryName));
    assert(image && typeof image === 'object' && !Array.isArray(image) &&
      IMAGE_ID.test(image.Id) &&
      Array.isArray(image.RepoDigests) &&
      image.RepoDigests.some(value =>
        acceptedNames.some(repo => value === repo + '@' + digest)) &&
      container && container.Config?.Image === lock &&
      container.Image === image.Id);
    ids[name] = image.Id;
  }
  assert(ids.db !== ids.redis);
  return ids;
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
    validateHostIsolation(c.HostConfig);
    const labels = c.Config.Labels || {};
    assert(labels['com.docker.compose.project'] === PROJECT &&
      labels['com.docker.compose.service'] === name);
    assert(c.State.Running === true && c.State.Status === 'running' &&
      c.State.Health?.Status === 'healthy' && c.RestartCount === 0 &&
      IMAGE_ID.test(c.Image));
    const nets = Object.keys(c.NetworkSettings.Networks || {});
    assert(nets.length === 1 && nets[0] === NETWORK);
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
      assert(c.Config.Image === reference &&
        (!immutable || c.Image === reference) &&
        labels['org.opencontainers.image.revision'] === sha);
    } else {
      assert(c.Config.Image === (name === 'db' ? BASE_REFS.postgis : BASE_REFS.redis));
    }
    if (name === 'backend') {
      const env = envValues(c.Config.Env);
      // Validate the ACTUAL running backend environment, not only the
      // previously resolved Compose file. Healthy containers can still point
      // queues at production Redis or use a malformed database connection.
      assert(env.NODE_ENV === 'production' && env.SEED_MODE === 'prod' &&
        env.BASE_DOMAIN === host && env.CORS_ORIGIN === 'https://' + host &&
        env.SEDEAGRO_BUILD_SHA === sha && env.LOG_SQL === '0' &&
        env.LOG_STACK === '0' && env.LOG_FORMAT === 'json' &&
        env.LOG_LEVEL === 'info' && env.PORT === '3001' &&
        env.REDIS_URL === 'redis://redis:6379');

      let url;
      try { url = new URL(env.DATABASE_URL); } catch { assert(false); }
      // Match the same staging-only authority and credential constraints
      // required at Compose admission. Never disclose secret values.
      const safeSecret = value => typeof value === 'string' &&
        value.length >= 24 && value.length <= 512 &&
        /^[a-zA-Z0-9._~-]+$/.test(value) &&
        !/replace|change|demo|example|password|secret|testing/i.test(value);
      assert(url.protocol === 'postgres:' && url.hostname === 'db' &&
        url.port === '5432' && url.pathname === '/sedeagro_staging' &&
        url.username === 'sedeagro_staging_app' && !url.search && !url.hash &&
        safeSecret(url.password) &&
        safeSecret(env.JWT_SECRET) && env.JWT_SECRET.length >= 32 &&
        env.JWT_SECRET !== url.password);
    }
    images[name] = c.Image; // LOCAL Docker image ID; not a registry digest attestation.
    if (immutable) {
      assert(typeof c.Id === 'string' && /^[a-f0-9]{64}$/.test(c.Id));
      containerIds[name] = c.Id;
    }
  }
  if (immutable) assert(new Set(Object.values(containerIds)).size === SERVICES.length);
  // Requested loopback bindings alone cannot prove the runtime listener/NAT.
  validateStagingEffectivePorts(containers);
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
  const report = validateStagingContainers(containers,{sha,host,signedImageIds});
  if (immutable) {
    // Service-by-service queries cannot discover an orphan with a different
    // or unknown service label. Inventory ALL project containers independently,
    // including stopped ones. A signed staging review must have exactly four.
    const raw = execute(['container','ls','--all','--quiet','--no-trunc',
      '--filter','label=com.docker.compose.project=' + PROJECT]);
    assert(typeof raw === 'string' && raw.length < 1024);
    const fullIds = raw.trim().split(/\s+/).filter(Boolean);
    assert(fullIds.length === SERVICES.length &&
      fullIds.every(id => /^[a-f0-9]{64}$/.test(id)) &&
      new Set(fullIds).size === SERVICES.length &&
      SERVICES.every(name => fullIds.includes(report.container_ids[name])));
    report.project_container_census_verified = true;
    // Image identity for db/redis must also be bound to the pinned upstream
    // digest and the *running* image ID, not Config.Image alone.
    const baseImages = {};
    for (const [name,reference] of [
      ['db',BASE_REFS.postgis],['redis',BASE_REFS.redis]
    ]) {
      const rawImage = execute(['image','inspect','--format','{{json .}}',reference]);
      assert(typeof rawImage === 'string' && rawImage.length > 0 &&
        rawImage.length < 65536);
      try { baseImages[name] = JSON.parse(rawImage); } catch { assert(false); }
    }
    report.project_base_image_ids =
      validateStagingBaseImageInventory(baseImages, containers);
    report.project_base_image_inventory_verified = true;
    // Read Docker's actual volume metadata, not solely the container's
    // reported Mounts.Name. Fixed names only; no operator-chosen volume.
    const volumeNames = {
      db: PROJECT + '_staging_pgdata',
      redis: PROJECT + '_staging_redisdata'
    };
    const volumes = {};
    for (const name of ['db','redis']) {
      const result = execute(['volume','inspect','--format','{{json .}}',volumeNames[name]]);
      assert(typeof result === 'string' && result.length > 0 && result.length < 16384);
      try { volumes[name] = JSON.parse(result); } catch { assert(false); }
    }
    validateStagingVolumeInventory(volumes, containers);
    report.project_volume_inventory_verified = true;
    // NetworkSettings.Networks does not prove the actual bridge is internal.
    // Inspect exactly the pinned Compose network, including its connected
    // endpoints, without touching any production network or service.
    const rawNetwork = execute(['network','inspect','--format','{{json .}}',NETWORK]);
    assert(typeof rawNetwork === 'string' && rawNetwork.length > 0 &&
      rawNetwork.length < 65536);
    let inspectedNetwork;
    try { inspectedNetwork = JSON.parse(rawNetwork); } catch { assert(false); }
    report.project_network_id = validateStagingNetworkInventory(inspectedNetwork, containers);
    report.project_network_inventory_verified = true;
  }
  return report;
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
