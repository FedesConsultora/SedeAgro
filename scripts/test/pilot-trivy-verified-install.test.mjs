// Regression contract for a real, fail-closed image vulnerability scan.
// An external setup-trivy asset mirror failure must never bypass SBOM/Trivy
// verification, OCI binding, or the protected production-image job.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow=readFileSync(new URL('../../.github/workflows/postgres-isolation.yml',
  import.meta.url),'utf8');
const scanBlocks=workflow.match(/- name: Scan built (?:backend|frontend) OS and libraries with Trivy v0\.76\.1[\s\S]*?(?=\n      - name:|\n  [a-z][\w-]*:|$)/g)||[];
test('both production image scans run pinned Trivy with verified installation, never skipped',()=>{
  assert.equal(scanBlocks.length,2);
  assert.match(workflow,/Install SHA256-verified Trivy v0\.76\.1 for real image scans/);
  assert.match(workflow,/trivy_0\.76\.1_Linux-64bit\.tar\.gz/);
  assert.match(workflow,/c7cbe3137fb8a48a17574bede3dd6beb16742d1e9772929940fc90082c39d9c0/);
  assert.match(workflow,/sha256sum --check --status/);
  assert.match(workflow,/curl --fail --location --show-error --silent/);
  assert.match(workflow,/--retry 5 --retry-all-errors/);
  assert.match(workflow,/set -euo pipefail/);
  assert.match(workflow,/Check nonsecret Syft\/Trivy output structure before strict security admission/);
  assert.match(workflow,/Bind both Syft and Trivy reports to immutable Docker image IDs/);
  for(const block of scanBlocks){
    assert.match(block,/uses: aquasecurity\/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25/);
    assert.match(block,/version: v0\.76\.1/);
    assert.match(block,/skip-setup-trivy: 'true'/);
    assert.match(block,/format: json/);
    assert.match(block,/severity: UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL/);
    assert.match(block,/cache: 'false'/);
    assert.match(block,/timeout: 10m/);
    assert.doesNotMatch(block,/continue-on-error|if:\s*false|skip-trivy|exit-code: '[1-9]'/);
  }
});
