// 0P.24 — CI-only, read-only byte parity of the ACTUAL production Nginx image
// and the independently built frontend dist + staging-release-manifest.
// Never starts a container, connects to a daemon inside it, or touches a VPS.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync,
  readdirSync, realpathSync, rmSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateReleaseManifest } from './verify-deployed-staging.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HEX40 = /^[a-f0-9]{40}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const CONTAINER_ID = /^[a-f0-9]{64}$/;
const MAX_FILES = 500;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 150 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 128 * 1024;

function block(reason) {
  throw new Error('FRONTEND_IMAGE_PARITY_BLOCKED: ' + reason);
}
function expect(condition, reason) {
  if (!condition) block(reason);
}
function digest(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function validateImageIdentity(image, sha) {
  expect(HEX40.test(sha || ''), 'exact HEAD SHA is mandatory');
  const tag = 'sedeagro-frontend-rc:' + sha;
  expect(image && typeof image === 'object' && !Array.isArray(image) &&
    IMAGE_ID.test(image.Id || '') &&
    Array.isArray(image.RepoTags) && image.RepoTags.includes(tag) &&
    image.Config && image.Config.Labels?.['org.opencontainers.image.revision'] === sha,
  'local production image digest, revision label or tag mismatch');
  // Config is intentionally NOT returned: env values could contain secrets.
  return { image_id: image.Id, image_tag: tag };
}

function readTree(directory) {
  const root = resolve(directory);
  expect(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(),
    'copied image root must be an ordinary directory');
  const names = new Map();
  let total = 0;
  function visit(where) {
    for (const entry of readdirSync(where, { withFileTypes: true })) {
      const abs = join(where, entry.name);
      const stat = lstatSync(abs);
      expect(!stat.isSymbolicLink() &&
        (stat.isDirectory() || (stat.isFile() && stat.nlink === 1)),
      'no symlink, hard-linked file or special file');
      const name = relative(root, abs).split(sep).join('/');
      expect(name.length <= 240 && !name.includes('//') &&
        !name.split('/').some(part => part === '.' || part === '..'),
      'unsafe artifact path');
      if (stat.isDirectory()) {
        visit(abs);
      } else {
        expect(stat.size > 0 && stat.size <= MAX_FILE_BYTES,
          'unexpected artifact size');
        expect(names.size < MAX_FILES, 'too many image artifacts');
        total += stat.size;
        expect(total <= MAX_TOTAL_BYTES, 'image artifacts exceed memory-safe bound');
        names.set(name, { size: stat.size, sha256: digest(readFileSync(abs)) });
      }
    }
  }
  visit(root);
  return names;
}

export function verifyCopiedFrontend({ htmlDir, nginxCopy, manifest, sha, nginxReference }) {
  const files = validateReleaseManifest(manifest, sha);
  const expected = new Map(files.map(item => [item.path, item]));
  const actual = readTree(htmlDir);
  expect(actual.size === expected.size,
    'frontend image has missing or unmanifested files');
  expect([...expected.keys()].every(name => actual.has(name)),
    'frontend hashed asset path set differs from the CI manifest');
  for (const [name, expectedFile] of expected) {
    const found = actual.get(name);
    expect(found.size === expectedFile.size,
      'frontend file size differs from the CI manifest');
    expect(found.sha256 === expectedFile.sha256,
      'frontend file SHA256 differs from the CI manifest');
  }
  const nginxStat = lstatSync(nginxCopy);
  const referenceStat = lstatSync(nginxReference);
  expect(nginxStat.isFile() && !nginxStat.isSymbolicLink() && nginxStat.nlink === 1 &&
    referenceStat.isFile() && !referenceStat.isSymbolicLink() &&
    nginxStat.size > 0 && nginxStat.size <= MAX_FILE_BYTES &&
    nginxStat.size === referenceStat.size,
  'production Nginx configuration is missing or unsafe');
  const nginxSha = digest(readFileSync(nginxCopy));
  expect(nginxSha === digest(readFileSync(nginxReference)),
    'production Nginx configuration differs from the reviewed source');
  return {
    files_verified: files.length,
    bytes_verified: files.reduce((sum, item) => sum + item.size, 0),
    nginx_sha256: nginxSha
  };
}

const docker = args => execFileSync('docker', args, {
  encoding: 'utf8', timeout: 60000, maxBuffer: 512 * 1024,
  stdio: ['ignore', 'pipe', 'pipe']
});

export function verifyFrontendImage({ sha, manifest, executor = docker,
  nginxReference = join(ROOT, 'frontend/nginx.conf') } = {}) {
  validateReleaseManifest(manifest, sha); // deny untrusted manifest BEFORE Docker
  const tag = 'sedeagro-frontend-rc:' + sha;
  const raw = executor(['image', 'inspect', '--format', '{{json .}}', tag]);
  expect(typeof raw === 'string' && raw.length <= 512 * 1024,
    'Docker image metadata invalid');
  const identity = validateImageIdentity(JSON.parse(raw), sha);
  // Creating a STOPPED container is necessary only to copy immutable assets;
  // --network none prevents attaching even a stopped container to shared nets.
  let container = null;
  let temp = null;
  let result = null;
  let problem = null;
  try {
    container = String(executor([
      'create', '--network', 'none', '--entrypoint', '/bin/true', tag
    ])).trim();
    expect(CONTAINER_ID.test(container), 'Docker returned invalid stopped container ID');
    temp = mkdtempSync(join(tmpdir(), 'sedeagro-ci-frontend-parity-'));
    chmodSync(temp, 0o700);
    const htmlDir = join(temp, 'html');
    mkdirSync(htmlDir, { mode: 0o700 });
    const nginxCopy = join(temp, 'default.conf');
    executor(['cp', container + ':/usr/share/nginx/html/.', htmlDir]);
    executor(['cp', container + ':/etc/nginx/conf.d/default.conf', nginxCopy]);
    const parity = verifyCopiedFrontend({
      htmlDir, nginxCopy, nginxReference, manifest, sha
    });
    result = {
      status: 'CI_IMAGE_PARITY_REVIEW_REQUIRED',
      release_sha: sha,
      image_id: identity.image_id,
      files_verified: parity.files_verified,
      bytes_verified: parity.bytes_verified,
      nginx_sha256: parity.nginx_sha256,
      registry_digest_certified: false,
      deployed_staging_certified: false
    };
  } catch (error) {
    problem = error;
  } finally {
    if (container) {
      try {
        executor(['rm', '--force', container]);
      } catch {
        problem = new Error('FRONTEND_IMAGE_PARITY_BLOCKED: cannot remove inspection container');
      }
    }
    if (temp) {
      try { rmSync(temp, { recursive: true, force: true }); }
      catch { problem = new Error('FRONTEND_IMAGE_PARITY_BLOCKED: cannot remove local temporary artifact'); }
    }
  }
  if (problem) throw problem;
  return result;
}

function main() {
  if (process.argv.length !== 4 || process.argv[2] !== '--sha' ||
      process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true') {
    block('only exact-head CI invocation is allowed');
  }
  const sha = process.argv[3];
  expect(HEX40.test(sha) && sha === process.env.IMAGE_SHA,
    'CLI SHA must equal the exact CI image build SHA');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: ROOT, encoding: 'utf8', timeout: 5000
  }).trim();
  expect(head === sha, 'checkout is not the CI release SHA');
  const manifestPath = join(ROOT, 'staging-release-manifest.json');
  const file = lstatSync(manifestPath);
  expect(file.isFile() && !file.isSymbolicLink() &&
    file.size > 0 && file.size <= MAX_MANIFEST_BYTES,
  'release manifest missing, unsafe or oversized');
  expect(realpathSync(manifestPath) === manifestPath,
    'manifest must be a canonical workspace file');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const outcome = verifyFrontendImage({ sha, manifest });
  console.log(JSON.stringify(outcome));
  console.log('NOT CERTIFIED: registry digest, remote deployed bytes, HTTPS, DB/RLS staging or field QA.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) {
    // Only our fixed authored messages are safe for public CI logs. Raw
    // Docker, filesystem, manifest, URLs or environment errors are redacted.
    const reason = typeof error?.message === 'string' &&
      error.message.startsWith('FRONTEND_IMAGE_PARITY_BLOCKED: ') &&
      error.message.length <= 180 ? error.message : 'unclassified verification failure';
    console.error('BLOCKED frontend image parity: ' + reason);
    process.exitCode = 2;
  }
}
