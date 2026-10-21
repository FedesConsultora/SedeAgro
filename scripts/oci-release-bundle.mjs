// 0P.25 — Read-only Docker-save tar inspector and offline receipt verifier.
// A CI hash receipt is NOT a signature, registry digest or deployed attestation.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  createReadStream, lstatSync, openSync, readFileSync, readSync,
  closeSync, statSync, writeFileSync
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HEX40 = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const MAX_ARCHIVE = 1536 * 1024 * 1024;
const MAX_METADATA = 2 * 1024 * 1024;
const MAX_ENTRIES = 2048;
const CHUNK = 1024 * 1024;
const SERVICES = ['backend', 'frontend'];
const SCHEMA = 'sedeagro-ci-docker-save-v1';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) { throw new Error('OCI_BUNDLE_BLOCKED: ' + message); }
function check(value, message) { if (!value) fail(message); }
function safeFile(path, maximum) {
  const s = lstatSync(path);
  check(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 &&
    s.size > 0 && s.size <= maximum, 'unsafe or oversized archive/receipt');
  return s.size;
}
function utf8(field) {
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString('utf8');
}
function octal(field) {
  const value = utf8(field).trim();
  check(/^[0-7]{1,12}$/.test(value), 'non-octal tar metadata');
  const num = parseInt(value, 8);
  check(Number.isSafeInteger(num), 'unsafe tar numeric metadata');
  return num;
}
function safePath(name) {
  check(typeof name === 'string' && name.length > 0 && name.length <= 240 &&
    !name.startsWith('/') && !name.includes('\\') &&
    !name.includes('//') && !name.includes('\0') &&
    name.split('/').every(p => p !== '.' && p !== '..') &&
    /^[A-Za-z0-9._/+@=-]+$/.test(name),
  'unsafe archive member path');
  return name;
}
function readExactly(fd, start, bytes) {
  const out = Buffer.alloc(bytes);
  let offset = 0;
  while (offset < bytes) {
    const got = readSync(fd, out, offset, bytes - offset, start + offset);
    check(got > 0, 'truncated archive');
    offset += got;
  }
  return out;
}
function headerInfo(h) {
  const expected = octal(h.subarray(148, 156));
  let total = 0;
  for (let i = 0; i < 512; i++) total += i >= 148 && i < 156 ? 32 : h[i];
  check(expected === total, 'invalid TAR header checksum');
  const prefix = utf8(h.subarray(345, 500));
  const name = utf8(h.subarray(0, 100));
  const type = String.fromCharCode(h[156] || 48);
  const size = octal(h.subarray(124, 136));
  check(type === '0' || type === '5', 'unsupported TAR extension, symlink or hardlink');
  if (type === '5') check(size === 0, 'directory TAR member has payload');
  return { name: safePath(prefix ? prefix + '/' + name : name), size, type };
}

export function inspectDockerSaveTar(path) {
  const bytes = safeFile(path, MAX_ARCHIVE);
  check(bytes % 512 === 0, 'archive is not TAR-block aligned');
  const fd = openSync(path, 'r');
  const entries = new Map();
  let pos = 0, complete = false;
  const buffer = Buffer.alloc(CHUNK);
  try {
    while (pos + 512 <= bytes) {
      const header = readExactly(fd, pos, 512);
      if (header.every(b => b === 0)) {
        check(pos + 1024 <= bytes &&
          readExactly(fd, pos + 512, 512).every(b => b === 0),
        'TAR terminator missing');
        let p = pos + 1024;
        while (p < bytes) {
          const len = Math.min(CHUNK, bytes - p);
          check(readExactly(fd, p, len).every(b => b === 0),
            'trailing nonzero bytes after TAR terminator');
          p += len;
        }
        complete = true;
        break;
      }
      const { name, size, type } = headerInfo(header);
      check(!entries.has(name), 'duplicate TAR archive entry');
      check(entries.size < MAX_ENTRIES, 'too many image TAR entries');
      const start = pos + 512, end = start + size;
      check(Number.isSafeInteger(end) && end <= bytes, 'TAR member exceeds archive size');
      if (type === '0') {
        const hash = createHash('sha256');
        let offset = start;
        while (offset < end) {
          const want = Math.min(CHUNK, end - offset);
          const received = readSync(fd, buffer, 0, want, offset);
          check(received === want, 'incomplete image layer read');
          hash.update(buffer.subarray(0, received));
          offset += received;
        }
        entries.set(name, { type, size, offset: start, sha256: hash.digest('hex') });
      } else {
        entries.set(name, { type, size: 0, offset: start });
      }
      pos = start + Math.ceil(size / 512) * 512;
      check(Number.isSafeInteger(pos) && pos <= bytes, 'archive offset overflow');
    }
    check(complete, 'archive lacks standard TAR terminator');
  } finally { closeSync(fd); }
  return { bytes, entries };
}
function memberJson(fd, entries, path) {
  const member = entries.get(safePath(path));
  check(member?.type === '0' && member.size > 0 &&
    member.size <= MAX_METADATA, 'missing or oversized Docker manifest/config');
  try { return JSON.parse(readExactly(fd, member.offset, member.size).toString('utf8')); }
  catch { fail('invalid Docker manifest/config JSON'); }
}
function tag(service, sha) { return 'sedeagro-' + service + '-rc:' + sha; }
// Modern Docker-save exports both legacy manifest.json AND an OCI index.
// OCI image-manifest blobs must be authenticated and tied to the same two
// verified image configs, not blindly whitelisted as extra tar payloads.
function requireOCIBlob(fd, entries, referenced, descriptor) {
  check(descriptor && typeof descriptor === 'object' &&
    DIGEST.test(descriptor.digest || '') &&
    Number.isSafeInteger(descriptor.size) && descriptor.size > 0,
  'invalid OCI content descriptor');
  const path = 'blobs/sha256/' + descriptor.digest.slice(7);
  const file = entries.get(path);
  check(file?.type === '0' && file.size === descriptor.size &&
    'sha256:' + file.sha256 === descriptor.digest,
  'OCI blob digest or size mismatch');
  referenced.add(path);
  return path;
}
function inspectOCIIndex(fd, entries, referenced, images) {
  const hasIndex = entries.has('index.json');
  const hasLayout = entries.has('oci-layout');
  check(hasIndex === hasLayout, 'OCI index and layout must be present together');
  if (!hasIndex) return;
  const layout = memberJson(fd, entries, 'oci-layout');
  check(layout?.imageLayoutVersion === '1.0.0',
    'unsupported OCI archive layout');
  const index = memberJson(fd, entries, 'index.json');
  check(index?.schemaVersion === 2 && Array.isArray(index.manifests) &&
    index.manifests.length === images.length,
  'OCI index must describe exactly the two release images');
  referenced.add('oci-layout');
  referenced.add('index.json');
  const seenConfigs = new Set();
  const seenManifestBlobs = new Set();
  for (const descriptor of index.manifests) {
    check(['application/vnd.oci.image.manifest.v1+json',
      'application/vnd.docker.distribution.manifest.v2+json']
      .includes(descriptor?.mediaType),
    'OCI index references unexpected artifact type');
    const path = requireOCIBlob(fd, entries, referenced, descriptor);
    check(!seenManifestBlobs.has(path), 'duplicate OCI image manifest');
    seenManifestBlobs.add(path);
    const imageManifest = memberJson(fd, entries, path);
    check(imageManifest.schemaVersion === 2 &&
      Array.isArray(imageManifest.layers) &&
      imageManifest.config && DIGEST.test(imageManifest.config.digest || ''),
    'invalid OCI image manifest');
    const matching = images.find(i => i.config_id === imageManifest.config.digest);
    check(matching && !seenConfigs.has(matching.config_id),
      'OCI image manifest does not refer to exactly one release config');
    seenConfigs.add(matching.config_id);
    requireOCIBlob(fd, entries, referenced, imageManifest.config);
    check(imageManifest.layers.length === matching.layers.length,
      'OCI and Docker-save rootfs layer counts differ');
    for (const layer of imageManifest.layers) {
      check(typeof layer.mediaType === 'string' &&
        /(?:image\.layer\.v1\.tar|rootfs\.diff\.tar)/.test(layer.mediaType),
      'OCI layer is not a filesystem tar layer');
      requireOCIBlob(fd, entries, referenced, layer);
    }
  }
  check(seenConfigs.size === images.length,
    'OCI image index is missing backend or frontend release');
}

function dockerImages(path, sha, scanned) {
  check(HEX40.test(sha || ''), 'expected exact git SHA40');
  const fd = openSync(path, 'r');
  try {
    const manifest = memberJson(fd, scanned.entries, 'manifest.json');
    check(Array.isArray(manifest) && manifest.length === 2,
      'archive must contain exactly two image entries');
    const referenced = new Set(['manifest.json']);
    const images = [];
    for (const service of SERVICES) {
      const requiredTag = tag(service, sha);
      const matches = manifest.filter(e =>
        Array.isArray(e?.RepoTags) && e.RepoTags.includes(requiredTag));
      check(matches.length === 1, 'exact immutable release image tag missing or duplicate');
      const e = matches[0];
      check(e.RepoTags.length === 1 && e.RepoTags[0] === requiredTag &&
        typeof e.Config === 'string' && Array.isArray(e.Layers) &&
        e.Layers.length > 0 && e.Layers.length <= 256,
      'unexpected image tags or layer manifest');
      const configName = safePath(e.Config);
      referenced.add(configName);
      const configEntry = scanned.entries.get(configName);
      check(configEntry?.type === '0' && configEntry.size <= MAX_METADATA,
        'missing image config blob');
      const configId = 'sha256:' + configEntry.sha256;
      check(DIGEST.test(configId), 'invalid config digest');
      const config = memberJson(fd, scanned.entries, configName);
      check(config?.config?.Labels?.['org.opencontainers.image.revision'] === sha,
        'image config revision label does not match release SHA');
      check(config.os === 'linux' && config.architecture === 'amd64',
        'unexpected exported platform');
      const diffIds = config?.rootfs?.diff_ids;
      check(config.rootfs.type === 'layers' && Array.isArray(diffIds) &&
        diffIds.length === e.Layers.length, 'wrong rootfs descriptor count');
      if (service === 'backend') {
        check(Array.isArray(config.config.Env) &&
          config.config.Env.includes('SEDEAGRO_BUILD_SHA=' + sha),
        'backend runtime SHA differs from release');
      }
      const perImage = new Set();
      for (let i = 0; i < e.Layers.length; i++) {
        const layerName = safePath(e.Layers[i]);
        check(!perImage.has(layerName), 'duplicate layer in image');
        perImage.add(layerName);
        referenced.add(layerName);
        const layer = scanned.entries.get(layerName);
        check(layer?.type === '0' && layer.size > 0,
          'image layer is missing or empty');
        check('sha256:' + layer.sha256 === diffIds[i],
          'image uncompressed rootfs diff_id does not match layer bytes');
      }
      images.push({ service, tag: requiredTag, config_id: configId,
        architecture: config.architecture, os: config.os,
        layers: diffIds.slice() });
    }
    inspectOCIIndex(fd, scanned.entries, referenced, images);
    for (const [name, entry] of scanned.entries) {
      if (entry.type === '5' || referenced.has(name) || name === 'repositories') continue;
      if (/^blobs\/sha256\/[a-f0-9]{64}$/.test(name)) {
        // Only safe, bounded diagnostic CATEGORY; no hash, paths or image
        // metadata content is ever logged from private release archives.
        check(entry.sha256 === name.slice(-64), 'orphan OCI blob filename/hash mismatch');
        let category = 'binary-layer';
        if (entry.size <= MAX_METADATA) {
          try {
            const payload = JSON.parse(readExactly(fd, entry.offset, entry.size).toString('utf8'));
            category = payload?.rootfs ? 'image-config' :
              payload?.schemaVersion === 2 && Array.isArray(payload?.layers) ? 'image-manifest' :
              payload?.schemaVersion === 2 && Array.isArray(payload?.manifests) ? 'image-index' :
              Array.isArray(payload) ? 'json-array' :
              payload && typeof payload === 'object' ?
                'json-keys-' + Object.keys(payload).sort()
                  .slice(0, 8).map(key =>
                    /^[A-Za-z_]{1,26}$/.test(key) &&
                    !/(?:password|token|secret|auth|private|key|credential|user)/i.test(key)
                      ? key : 'redacted').join('-') :
                'json-primitive';
          } catch { /* binary blob, not metadata */ }
        }
        fail('unreferenced OCI ' + category + ' blob in archive');
      }
      fail('unexpected unreferenced non-OCI payload in archive');
    }
    return images;
  } finally { closeSync(fd); }
}
async function hashArchive(path) {
  const hash = createHash('sha256');
  for await (const piece of createReadStream(path, { highWaterMark: CHUNK })) {
    hash.update(piece);
  }
  return hash.digest('hex');
}
export async function computeReceipt({ bundlePath, sha }) {
  const tar = inspectDockerSaveTar(bundlePath);
  const images = dockerImages(bundlePath, sha, tar);
  return {
    schema: SCHEMA, head: sha, format: 'docker-save-tar',
    archive: { name: basename(bundlePath), bytes: tar.bytes,
      sha256: await hashArchive(bundlePath) },
    images, registry_digest_certified: false,
    signed_provenance_certified: false, staging_deployment_certified: false
  };
}
export async function verifyReceipt({ bundlePath, receiptPath, sha }) {
  check(HEX40.test(sha || ''), 'operator must supply exact release SHA');
  safeFile(receiptPath, 64 * 1024);
  let provided;
  try { provided = JSON.parse(readFileSync(receiptPath, 'utf8')); }
  catch { fail('malformed release receipt'); }
  const computed = await computeReceipt({ bundlePath, sha });
  check(JSON.stringify(provided) === JSON.stringify(computed),
    'archive bytes and image config differ from receipt or expected release');
  return { status: 'OFFLINE_BUNDLE_VERIFIED_NOT_DEPLOYED',
    head: sha, archive_sha256: computed.archive.sha256,
    archive_bytes: computed.archive.bytes,
    image_ids: Object.fromEntries(computed.images.map(i => [i.service, i.config_id])),
    registry_digest_certified: false, signed_provenance_certified: false };
}
export async function createCIReceipt({ bundlePath, receiptPath, sha, imageInspect }) {
  check(HEX40.test(sha || ''), 'CI SHA40 is mandatory');
  const receipt = await computeReceipt({ bundlePath, sha });
  check(receipt.archive.name === 'sedeagro-images-' + sha + '.tar',
    'wrong archive name for exact SHA');
  for (const im of receipt.images) {
    const live = imageInspect(im.tag);
    check(live?.Id === im.config_id &&
      live.Config?.Labels?.['org.opencontainers.image.revision'] === sha &&
      live.Os === im.os && live.Architecture === im.architecture &&
      JSON.stringify(live.RootFS?.Layers) === JSON.stringify(im.layers),
    'live built local Docker image differs from tar config and rootfs identity');
  }
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 });
  return verifyReceipt({ bundlePath, receiptPath, sha });
}
function cliArgs() {
  const a = process.argv.slice(2);
  check(a.length === 7 && ['create', 'verify'].includes(a[0]) &&
    a[1] === '--sha' && a[3] === '--bundle' && a[5] === '--receipt',
  'use create|verify --sha SHA40 --bundle TAR --receipt JSON');
  return { mode: a[0], sha: a[2], bundlePath: resolve(a[4]),
    receiptPath: resolve(a[6]) };
}
async function main() {
  const arg = cliArgs();
  let result;
  if (arg.mode === 'create') {
    check(process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true' &&
      process.env.IMAGE_SHA === arg.sha && HEX40.test(arg.sha),
    'creation restricted to exact SHA GitHub Actions CI');
    const head = execFileSync('git', ['rev-parse', 'HEAD'],
      { cwd: ROOT, encoding: 'utf8', timeout: 5000 }).trim();
    check(head === arg.sha, 'checkout does not equal approved CI SHA');
    const dir = resolve(process.env.RUNNER_TEMP || '/invalid-runner-temp',
      'sedeagro-oci');
    check(dirname(arg.bundlePath) === dir && dirname(arg.receiptPath) === dir &&
      basename(arg.receiptPath) === 'sedeagro-images-' + arg.sha + '.json' &&
      statSync(dir).isDirectory(), 'CI output must reside in fixed temporary folder');
    result = await createCIReceipt({ ...arg, imageInspect: imageTag =>
      JSON.parse(execFileSync('docker',
        ['image', 'inspect', '--format', '{{json .}}', imageTag],
        { encoding: 'utf8', timeout: 12000, maxBuffer: 512 * 1024 })) });
  } else {
    // OFFLINE validation performs no Git/Docker/network calls or image imports.
    result = await verifyReceipt(arg);
  }
  console.log(JSON.stringify(result));
  console.log('NOT CERTIFIED: registry digest/signature, remote deployment, HTTPS, DB or physical QA.');
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    // Docker and file errors may include secrets/paths; authored codes only.
    const safe = /^OCI_BUNDLE_BLOCKED: [A-Za-z0-9 _,.:\-]+$/.test(error?.message || '') &&
      error.message.length <= 170 ? error.message : 'opaque input/IO failure';
    console.error('BLOCKED OCI release bundle: ' + safe);
    process.exitCode = 2;
  });
}
