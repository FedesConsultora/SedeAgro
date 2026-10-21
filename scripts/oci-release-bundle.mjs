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
    for (const [name, entry] of scanned.entries) {
      if (entry.type === '5') continue;
      check(referenced.has(name) ||
        ['repositories', 'index.json', 'oci-layout'].includes(name),
      'unexpected file or unused image layer in archive');
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
    const safe = /^OCI_BUNDLE_BLOCKED: [A-Za-z0-9 ,.:\-]+$/.test(error?.message || '') &&
      error.message.length <= 170 ? error.message : 'opaque input/IO failure';
    console.error('BLOCKED OCI release bundle: ' + safe);
    process.exitCode = 2;
  });
}
