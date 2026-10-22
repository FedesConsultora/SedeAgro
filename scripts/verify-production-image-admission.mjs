// 0P.33 — Read-only production image admission. Intentionally fail closed.
// A CI scan/signature is NOT permission to deploy or evidence that a locally
// rebuilt Compose image is byte-identical to CI's signed Docker-save artifact.
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifySecuritySignatures } from './verify-image-security.mjs';
import { verifySignedRelease } from './verify-oci-signed-provenance.mjs';

const SHA40 = /^[a-f0-9]{40}$/;
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SECURITY_STATUS = 'GITHUB_SIGNED_IMAGE_SECURITY_VERIFIED_RELEASE_NOT_CERTIFIED';
const OCI_STATUS = 'GITHUB_SIGNED_OCI_ARTIFACTS_VERIFIED_NOT_DEPLOYED';

function deny(message) { throw new Error('PRODUCTION_IMAGE_ADMISSION_BLOCKED: ' + message); }
function check(ok, message) { if (!ok) deny(message); }

function secureDirectory(dir) {
  check(typeof dir === 'string' && dir.length > 0 && dir.length < 4096,
    'dedicated release evidence directory required');
  const absolute = resolve(dir);
  const stat = lstatSync(absolute);
  check(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 &&
    (typeof process.getuid !== 'function' || stat.uid === process.getuid()) &&
    realpathSync(absolute) === absolute &&
    absolute !== SRC && !absolute.startsWith(SRC + '/'),
  'release evidence must be private, canonical and outside the source checkout');
  return absolute;
}

export function verifySignedSecurityDecision(security, sha) {
  check(SHA40.test(sha || '') && security?.head === sha &&
    security.status === SECURITY_STATUS &&
    security.source_signed === true &&
    security.images_verified === 2 &&
    Array.isArray(security.subjects) && security.subjects.length === 5 &&
    security.subjects.map(s => s.name).join('|') === [
      'sedeagro-backend-' + sha + '.spdx.json',
      'sedeagro-backend-' + sha + '.trivy.json',
      'sedeagro-frontend-' + sha + '.spdx.json',
      'sedeagro-frontend-' + sha + '.trivy.json',
      'sedeagro-security-' + sha + '.json'
    ].join('|') &&
    security.subjects.every(s => /^sedeagro-(?:backend|frontend)-[a-f0-9]{40}\.(?:spdx|trivy)\.json$|^sedeagro-security-[a-f0-9]{40}\.json$/.test(s.name) &&
      s.name.includes(sha) && /^[a-f0-9]{64}$/.test(s.sha256)),
  'exact SHA and five verified GitHub-signed security subjects required');
  const review = security.review;
  check(review && Number.isSafeInteger(review.findings) && review.findings >= 0 &&
    review.severities && Number.isSafeInteger(review.severities.CRITICAL) &&
    Number.isSafeInteger(review.severities.HIGH) &&
    Number.isSafeInteger(review.severities.MEDIUM) &&
    Number.isSafeInteger(review.severities.UNKNOWN) &&
    Number.isSafeInteger(review.high_critical_findings) &&
    review.high_critical_findings ===
      review.severities.CRITICAL + review.severities.HIGH &&
    review.high_critical_findings === 0,
  'missing or nonzero HIGH/CRITICAL inventory');
  // Today's signed CI receipt has release_go:false even with zero HIGH.
  // It must never be treated as an affirmative security-owner decision.
  check(review.release_go === true &&
    review.security_owner_review_required === false &&
    review.release_gate === 'APPROVED_FOR_RELEASE',
  'explicit approved security-owner release decision missing; signed CI scan is review-only');
  return { head: sha, findings: review.findings };
}

export async function inspectProductionImageAdmission({
  sha, evidenceDir, securityVerifier = verifySecuritySignatures,
  ociVerifier = verifySignedRelease
} = {}) {
  check(SHA40.test(sha || ''), 'exact release SHA required');
  const base = secureDirectory(evidenceDir);
  const ociDir = secureDirectory(join(base, 'oci'));
  const securityDir = secureDirectory(join(base, 'security'));
  const receiptPath = join(ociDir, 'sedeagro-images-' + sha + '.json');
  const bundlePath = join(ociDir, 'sedeagro-images-' + sha + '.tar');
  const security = securityVerifier({ sha, dir: securityDir,
    ociReceiptPath: receiptPath });
  verifySignedSecurityDecision(security, sha);
  const oci = await ociVerifier({ sha, bundlePath, receiptPath });
  check(oci?.head === sha && oci.status === OCI_STATUS &&
    oci.github_oidc_signature_checked === true &&
    oci.repository === 'FedesConsultora/SedeAgro' &&
    oci.signer_workflow === 'FedesConsultora/SedeAgro/.github/workflows/postgres-isolation.yml' &&
    oci.source_ref === 'refs/heads/main' &&
    Array.isArray(oci.subjects) && oci.subjects.length === 2,
  'exact signed OCI archive and receipt are mandatory');
  // Current deploy-prod.sh always executes docker compose build locally.
  // Even a future authorized signed security receipt cannot certify different
  // rebuilt image bytes. This permanent-in-current-release fence is removed
  // only in a separately reviewed change that imports and proves EXACT bytes.
  deny('deploy-prod.sh rebuilds Docker images; signed OCI bytes are not the deployed artifact');
}

async function main() {
  check(process.argv.length === 6 && process.argv[2] === '--sha' &&
    process.argv[4] === '--evidence-dir',
  'expected --sha SHA40 --evidence-dir PRIVATE_DIR');
  await inspectProductionImageAdmission({
    sha: process.argv[3], evidenceDir: process.argv[5]
  });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(() => {
    // Deliberately omit the raw CLI, GitHub, file path and auth errors.
    console.error('BLOCKED production image admission: missing approved signed evidence or exact deploy bytes');
    process.exitCode = 2;
  });
}
