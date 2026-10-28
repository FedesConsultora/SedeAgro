// 0P.28 — immutable Docker base-image policy. Verify exact source references
// OFFLINE first; optionally query Docker Hub by content digest, not by tag.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const TAGS = {
  node: 'node:22-alpine',
  nginx: 'nginx:1.30.6-alpine3.24-slim',
  postgis: 'postgis/postgis:16-3.4',
  redis: 'redis:7-alpine'
};
const MEDIA = {
  node: 'application/vnd.oci.image.index.v1+json',
  nginx: 'application/vnd.oci.image.index.v1+json',
  postgis: 'application/vnd.docker.distribution.manifest.v2+json',
  redis: 'application/vnd.oci.image.index.v1+json'
};
const FILES = {
  'backend/Dockerfile': { node: 1 },
  'frontend/Dockerfile': { node: 2, nginx: 1 },
  'docker-compose.yml': { postgis: 1, redis: 1 },
  'docker-compose.dev.yml': { postgis: 1, redis: 1 },
  'docker-compose.staging.yml': { postgis: 1, redis: 1 },
  // Two independent disposable PostGIS jobs: RLS+restore and Chromium E2E.
  // Both services must use the exact same reviewed SHA digest.
  '.github/workflows/postgres-isolation.yml': { postgis: 2 }
};
const RECOVERY_SHELL_FILES = {
  'scripts/ci-disposable-restore.sh': 1,
  'scripts/ci-independent-recovery.sh': 3,
  'scripts/ci-rollback-rehearsal.sh': 1
};
const ALL_FILES = [...Object.keys(FILES), ...Object.keys(RECOVERY_SHELL_FILES)];

function block(reason) { throw new Error('BASE_IMAGE_PIN_BLOCKED: ' + reason); }
function ensure(ok, reason) { if (!ok) block(reason); }

export function validateBaseImageLock(lock) {
  ensure(lock?.schema === 'sedeagro-base-images-v1' &&
    lock.platform === 'linux/amd64' && lock.images &&
    Object.keys(lock.images).sort().join(',') === Object.keys(TAGS).sort().join(','),
  'base image lock has invalid schema or services');
  const refs = {};
  const allDigests = new Set();
  for (const [key, tag] of Object.entries(TAGS)) {
    const image = lock.images[key];
    ensure(image?.tag === tag && DIGEST.test(image.digest || '') &&
      image.media_type === MEDIA[key] && !allDigests.has(image.digest),
    'base image digest, source tag, media type or uniqueness invalid');
    allDigests.add(image.digest);
    refs[key] = tag + '@' + image.digest;
  }
  return refs;
}

function sourceLines(source, filename) {
  ensure(typeof source === 'string' && source.length > 0 &&
    source.length < 120000, 'source file unavailable or oversized');
  const results = [];
  // Only Dockerfile FROM or Docker service image declarations. Action
  // inputs such as "with: image:" are scanner arguments, not upstream bases.
  const regex = filename.endsWith('/Dockerfile')
    ? /^FROM\s+([^\s]+)/gm
    : filename === '.github/workflows/postgres-isolation.yml'
      ? /^ {8}image:\s+([^\s#]+)/gm
      : /^ {4}image:\s+([^\s#]+)/gm;
  let match;
  while ((match = regex.exec(source)) !== null) {
    const found = match[1].trim();
    // Internal Dockerfile stage name, not a separately pulled base image.
    if (filename === 'backend/Dockerfile' && found === 'base') continue;
    // These two service images are SedeAgro's own SHA-bound BUILDS, not bases.
    if (filename === 'docker-compose.staging.yml' &&
      /^sedeagro-staging-(?:backend|frontend):\$\{SEDEAGRO_STAGING_SHA:\?/.test(found)) {
      continue;
    }
    results.push(found);
  }
  return results;
}

export function validateBaseImageSources(lock, sources) {
  const refs = validateBaseImageLock(lock);
  ensure(sources && Object.keys(sources).sort().join(',') ===
    ALL_FILES.slice().sort().join(','), 'source file coverage incomplete');
  const policyValues = Object.values(refs);
  const counts = {};
  for (const [filename, expected] of Object.entries(FILES)) {
    const actual = sourceLines(sources[filename], filename);
    const wanted = Object.entries(expected)
      .flatMap(([key, count]) => Array(count).fill(refs[key]));
    ensure(actual.length === wanted.length,
      'number of immutable base references changed in ' + filename);
    for (const value of actual) {
      ensure(policyValues.includes(value),
        'mutable, unknown or drifted base image in ' + filename);
    }
    ensure(actual.slice().sort().join('\n') === wanted.slice().sort().join('\n'),
      'base image count or role changed in ' + filename);
    counts[filename] = actual.length;
  }
  for (const [filename, expectedCount] of Object.entries(RECOVERY_SHELL_FILES)) {
    const source = sources[filename];
    ensure(typeof source === 'string' && source.length > 0 &&
      source.length < 120000, 'CI recovery guard file missing or oversized');
    const actual = [...source.matchAll(/postgis\/postgis:[^\s'"()]+/g)]
      .map(match => match[0]);
    ensure(actual.length === expectedCount &&
      actual.every(reference => reference === refs.postgis),
    'CI recovery references unpinned or incorrect PostGIS image in ' + filename);
    counts[filename] = actual.length;
  }
  return {
    status: 'BASE_IMAGE_SOURCES_PINNED_REVIEW_REQUIRED',
    target_platform: lock.platform,
    unique_base_images: policyValues.length,
    source_files: ALL_FILES.length,
    references: counts,
    registry_provenance_signed: false,
    staging_deployed: false
  };
}

// Docker buildx imagetools inspect TAG@sha256:DIGEST performs remote
// registry lookup at that IMMUTABLE digest, never at a moving tag. Index
// manifests must contain a linux/amd64 entry; single-image PostGIS manifest
// is additionally checked by running the pinned CI PostGIS service on amd64.
export function validateImagetoolsOutput(stdout, image) {
  ensure(typeof stdout === 'string' && stdout.length > 0 &&
    stdout.length < 262144, 'registry inspect output invalid');
  const parsedDigest = stdout.match(/^Digest:\s*(sha256:[a-f0-9]{64})\s*$/m);
  const parsedMedia = stdout.match(/^MediaType:\s*(\S+)\s*$/m);
  ensure(parsedDigest?.[1] === image?.digest &&
    parsedMedia?.[1] === image.media_type,
  'registry manifest digest or media type differs from lock');
  if (image.media_type.includes('image.index')) {
    ensure(/^\s+Platform:\s+linux\/amd64\s*$/m.test(stdout),
      'pinned multi-platform index does not contain linux/amd64');
  }
  return image.digest;
}

export function inspectPinnedDigests(lock, execute = args =>
  execFileSync('docker', args, {
    cwd: ROOT, encoding: 'utf8', timeout: 45000,
    maxBuffer: 262144, stdio: ['ignore','pipe','pipe']
  })) {
  const refs = validateBaseImageLock(lock);
  for (const [key, reference] of Object.entries(refs)) {
    const output = execute(['buildx','imagetools','inspect',reference]);
    validateImagetoolsOutput(output, lock.images[key]);
  }
  return { status: 'PINNED_REGISTRY_MANIFESTS_REACHABLE_NOT_DEPLOYED',
    platform: lock.platform, verified: Object.keys(refs).length,
    postgis_platform_confirmed_by_runtime_service: false,
    staging_deployed: false };
}
function readSources() {
  return Object.fromEntries(ALL_FILES.map(path =>
    [path, readFileSync(resolve(ROOT, path), 'utf8')]));
}

if (process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    ensure(process.argv.length === 3 &&
      ['--offline', '--online'].includes(process.argv[2]),
    'usage requires --offline or --online');
    const lock = JSON.parse(readFileSync(
      resolve(ROOT, 'scripts/base-image-lock.json'), 'utf8'));
    const local = validateBaseImageSources(lock, readSources());
    console.log(JSON.stringify(local));
    if (process.argv[2] === '--online') {
      ensure(process.env.CI === 'true' &&
        process.env.GITHUB_ACTIONS === 'true',
      'live registry checks only permitted in disposable GitHub CI');
      console.log(JSON.stringify(inspectPinnedDigests(lock)));
    }
    console.log('NOT CERTIFIED: base image signatures, vulnerability remediation, runtime staging or deployment.');
  } catch {
    // Docker or config errors can include private runtime data; never echo.
    console.error('BLOCKED base image pins: invalid source lock, registry digest or platform');
    process.exitCode = 2;
  }
}
