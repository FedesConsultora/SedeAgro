// GitHub's moving ubuntu-latest advanced to 26.04 in October 2026.
// The pinned Playwright 1.58.2 browser install fails there, and the Docker
// runner changed strict OCI layer byte export. Block silent runner drift while
// retaining all security and real browser tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../../.github/workflows/postgres-isolation.yml', import.meta.url), 'utf8');

function job(name) {
  const marker = '\n  ' + name + ':\n';
  const start = workflow.indexOf(marker);
  assert.ok(start >= 0, 'missing mandatory job ' + name);
  const stop = /^  [a-z][a-z0-9-]*:\s*$/gm;
  stop.lastIndex = start + marker.length;
  const match = stop.exec(workflow);
  return workflow.slice(start + 1, match ? match.index : undefined);
}

test('all browser and OCI producer/consumer gates pin a compatible GitHub runner', () => {
  for (const name of ['browser-postgis', 'browser-offline', 'production-images', 'offline-image-import']) {
    const source = job(name);
    assert.match(source, /^    runs-on: ubuntu-24\.04$/m, name);
    assert.doesNotMatch(source, /runs-on: ubuntu-latest/, name);
    assert.doesNotMatch(source, /continue-on-error:\s*true/, name);
  }
});

test('runner pinning cannot bypass the existing Chromium or OCI verification', () => {
  const chrome = job('browser-postgis');
  const offline = job('browser-offline');
  const images = job('production-images');
  const importer = job('offline-image-import');
  assert.match(chrome, /npx playwright install chromium --with-deps/);
  assert.match(chrome, /for pass in 1 2; do/);
  assert.match(chrome, /SEDEAGRO_FOCUS_STRESS_CYCLES=12 node scripts\/acceptance-browser-cookie\.mjs/);
  assert.match(chrome, /node scripts\/acceptance-browser-evidence-history\.mjs/);
  assert.match(chrome, /node scripts\/acceptance-browser-review-inbox\.mjs/);
  assert.match(offline, /npx playwright install chromium --with-deps/);
  assert.match(offline, /node frontend\/test\/offlineBrowser\.mjs/);
  assert.match(images, /Verify built backend OS and libraries|Scan built backend OS and libraries/);
  assert.match(images, /Scan built frontend OS and libraries/);
  assert.match(images, /node scripts\/verify-frontend-image-parity\.mjs --sha "\$IMAGE_SHA"/);
  assert.match(images, /node scripts\/oci-release-bundle\.mjs verify --sha "\$IMAGE_SHA"/);
  assert.match(images, /node scripts\/verify-image-security\.mjs --mode verify/);
  assert.match(importer, /needs: \[production-images, attest-oci-bundle\]/);
  assert.match(importer, /node scripts\/oci-release-bundle\.mjs verify --sha "\$IMAGE_SHA"/);
  assert.match(importer, /node scripts\/verify-oci-signed-provenance\.mjs --sha "\$IMAGE_SHA"/);
  assert.match(importer, /node scripts\/verify-image-security\.mjs --mode verify-signed/);
  assert.match(importer, /node scripts\/ci-oci-import-rehearsal\.mjs --mode fresh/);
  assert.match(importer, /node scripts\/ci-oci-compose-parity\.mjs --sha "\$IMAGE_SHA"/);
  assert.match(importer, /node scripts\/ci-oci-container-creation\.mjs --sha "\$IMAGE_SHA"/);
});
