// 0P.27: cryptographic GitHub Actions attestation admission for transportable
// image TAR + receipt. The GitHub CLI verifies Sigstore certificate, signature,
// signer workflow/ref/digest, while this layer pins the exact subject hashes.
// No Docker, image load, deployment or registry API calls in this module.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyReceipt } from './oci-release-bundle.mjs';

const SHA40 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const REPO = 'FedesConsultora/SedeAgro';
const WORKFLOW = REPO + '/.github/workflows/postgres-isolation.yml';
const PREDICATE = 'https://slsa.dev/provenance/v1';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_ATTESTATION_OUTPUT = 4 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 64 * 1024;

function deny(message) { throw new Error('SIGNED_OCI_PROVENANCE_BLOCKED: ' + message); }
function requireSafe(ok, message) { if (!ok) deny(message); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function statRegular(file, maximum) {
  const stat = lstatSync(file);
  requireSafe(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 &&
    stat.size > 0 && stat.size <= maximum, 'release subject must be a bounded regular file');
  return stat;
}

export function attestationArgs(path, sha) {
  requireSafe(SHA40.test(sha || ''), 'expected exact source SHA');
  return [
    'attestation', 'verify', path,
    '--repo', REPO,
    '--signer-workflow', WORKFLOW,
    '--source-ref', 'refs/heads/main',
    '--source-digest', sha,
    '--predicate-type', PREDICATE,
    '--deny-self-hosted-runners',
    '--format', 'json'
  ];
}

export function validateVerifiedAttestation(output, { name, digest } = {}) {
  requireSafe(typeof name === 'string' && /^(?:sedeagro-images-[a-f0-9]{40}\.(?:tar|json)|sedeagro-(?:backend|frontend)-[a-f0-9]{40}\.(?:spdx|trivy)\.json|sedeagro-security-[a-f0-9]{40}\.json)$/.test(name) &&
    SHA256.test(digest || ''), 'invalid subject name or expected sha256');
  let entries;
  try { entries = typeof output === 'string' ? JSON.parse(output) : output; }
  catch { deny('GitHub CLI attestation output was invalid JSON'); }
  requireSafe(Array.isArray(entries) && entries.length >= 1 &&
    entries.length <= 30, 'GitHub CLI returned no verified attestations');
  const matching = entries.filter(entry => {
    const result = entry?.verificationResult;
    const statement = result?.statement;
    return statement?.predicateType === PREDICATE &&
      Array.isArray(statement.subject) &&
      statement.subject.some(s => s?.name === name &&
        s.digest?.sha256 === digest) &&
      result?.signature?.certificate &&
      Array.isArray(result?.verifiedTimestamps) &&
      result.verifiedTimestamps.length > 0;
  });
  requireSafe(matching.length > 0,
    'verified SLSA statement did not bind exact subject bytes and signing certificate');
  return { name, sha256: digest };
}
function defaultExecute(args) {
  return execFileSync('gh', args, {
    encoding: 'utf8', timeout: 120000,
    maxBuffer: MAX_ATTESTATION_OUTPUT,
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

export async function verifySignedRelease({ sha, bundlePath, receiptPath,
  verify = verifyReceipt, execute = defaultExecute } = {}) {
  requireSafe(SHA40.test(sha || ''), 'expected exact main Git SHA40');
  const files = [
    { path: bundlePath, name: 'sedeagro-images-' + sha + '.tar' },
    { path: receiptPath, name: 'sedeagro-images-' + sha + '.json' }
  ];
  requireSafe(files.every(item => typeof item.path === 'string' &&
    basename(item.path) === item.name),
  'bundle and receipt filenames must equal exact source SHA');
  statRegular(receiptPath, MAX_RECEIPT_BYTES);
  // Verifies FULL Docker-save tar and receipt SHA256, image config IDs and
  // rootfs layers before querying any externally signed statement.
  const preflight = await verify({ sha, bundlePath, receiptPath });
  requireSafe(preflight?.status === 'OFFLINE_BUNDLE_VERIFIED_NOT_DEPLOYED' &&
    preflight.head === sha && SHA256.test(preflight.archive_sha256 || '') &&
    preflight.registry_digest_certified === false &&
    preflight.signed_provenance_certified === false,
  'independent local OCI receipt validation is mandatory');
  const receiptDigest = sha256(readFileSync(receiptPath));
  const subjects = [
    { ...files[0], digest: preflight.archive_sha256 },
    { ...files[1], digest: receiptDigest }
  ];
  const checked = [];
  for (const subject of subjects) {
    // gh attestation verify validates Sigstore signatures and trusted OIDC
    // certificate actor identity with the explicit flags above. Never let
    // untrusted data control the repo, workflow, ref, SHA or CLI flags.
    const output = execute(attestationArgs(subject.path, sha));
    requireSafe(typeof output === 'string' && output.length > 0 &&
      output.length < MAX_ATTESTATION_OUTPUT, 'GitHub CLI verification output invalid');
    checked.push(validateVerifiedAttestation(output, subject));
  }
  return {
    status: 'GITHUB_SIGNED_OCI_ARTIFACTS_VERIFIED_NOT_DEPLOYED',
    head: sha,
    repository: REPO,
    signer_workflow: WORKFLOW,
    source_ref: 'refs/heads/main',
    subjects: checked,
    github_oidc_signature_checked: true,
    signed_registry_image_digest_certified: false,
    staging_deployment_certified: false
  };
}

function argsFromCli(argv) {
  requireSafe(argv.length === 8 && argv[2] === '--sha' &&
    argv[4] === '--bundle' && argv[6] === '--receipt',
  'use --sha SHA40 --bundle TAR --receipt JSON');
  return { sha: argv[3], bundlePath: resolve(argv[5]),
    receiptPath: resolve(argv[7]) };
}
async function main() {
  const args = argsFromCli(process.argv);
  requireSafe(process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true' &&
    process.env.GITHUB_EVENT_NAME === 'push' &&
    process.env.GITHUB_REF === 'refs/heads/main' &&
    process.env.GITHUB_REPOSITORY === REPO &&
    process.env.IMAGE_SHA === args.sha && SHA40.test(args.sha || ''),
  'main-only exact SHA GitHub Actions receiver required');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: ROOT, encoding: 'utf8', timeout: 5000
  }).trim();
  requireSafe(head === args.sha, 'receiver checkout differs from release SHA');
  const privateDir = resolve(process.env.RUNNER_TEMP || '/invalid-runner-temp', 'sedeagro-oci');
  requireSafe(dirname(args.bundlePath) === privateDir &&
    dirname(args.receiptPath) === privateDir, 'only private CI artifacts permitted');
  const result = await verifySignedRelease(args);
  // Avoid dumping verified certificates, workflow environment and private data.
  console.log(JSON.stringify(result));
  console.log('NOT CERTIFIED: registry OCI digest/signature, staging, database, field QA or production.');
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(() => {
    console.error('BLOCKED signed OCI provenance: missing or unverifiable exact SHA release attestation');
    process.exitCode = 2;
  });
}
