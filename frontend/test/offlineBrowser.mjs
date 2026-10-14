// Real Chromium smoke tests; runs only in CI's dedicated browser job.
// Uses localhost Vite to exercise actual IndexedDB, Web Crypto, and SW APIs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../');
const run = (command, args, port) => spawn(command, args, {
  cwd: resolve(root, 'frontend'),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT: String(port) }
});
async function ready(url) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* server starting */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error('Vite server failed to become ready: ' + url);
}

let server;
let browser;
try {
  server = run(process.execPath, [
    resolve(root, 'node_modules/vite/bin/vite.js'),
    '--host', '127.0.0.1', '--port', '4173', '--strictPort'
  ], 4173);
  await ready('http://127.0.0.1:4173/');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:4173/');

  const scope = '0b000000-0000-4000-8000-000000000001:0b000000-0000-4000-8000-000000000002';
  const uuid = '0b000000-0000-4000-8000-000000000003';
  const id = scope + ':' + uuid;
  const observation = {
    id, scope, runId: '0b000000-0000-4000-8000-000000000004',
    idempotencyKey: uuid, state: 'pending', attempts: 0,
    createdAt: new Date().toISOString(),
    body: {
      client_id: 'sedeagro-web-offline-v1', idempotency_key: uuid,
      operations: [{ entity_client_id: '0b000000-0000-4000-8000-000000000005',
        entity_type: 'scouting_observation', operation: 'create',
        payload: { scouting_run_id: '0b000000-0000-4000-8000-000000000004',
          observation_type: 'pest', notes: 'real-browser-sensitive-notes', severity: 'high' } }]
    },
    evidence: { client_upload_id: '0b000000-0000-4000-8000-000000000006',
      kind: 'photo', original_name: 'real-browser.png', mime_type: 'image/png',
      content_base64: 'iVBORw0KGgoAAA==' }
  };

  // Build an honest V1 database first; the new client must upgrade it without
  // erasing legacy records and must encrypt their content before returning it.
  await page.evaluate(async (row) => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('sedeagro-offline-sync', 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore('pending-observations', { keyPath: 'id' });
        store.createIndex('scope', 'scope', { unique: false });
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('pending-observations', 'readwrite');
        tx.objectStore('pending-observations').add(row);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
  }, observation);

  const first = await page.evaluate(async (accountScope) => {
    const { indexedDbQueueStore } = await import('/src/services/offlineQueueStore.js');
    const rows = await indexedDbQueueStore.list(accountScope);
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('sedeagro-offline-sync', 2);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const raw = await new Promise((resolve, reject) => {
      const tx = db.transaction('pending-observations', 'readonly');
      const req = tx.objectStore('pending-observations').get(rows[0].id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const hasKeyStore = db.objectStoreNames.contains('draft-keys');
    db.close();
    return {
      count: rows.length, notes: rows[0].body.operations[0].payload.notes,
      hasKeyStore, sealed: Boolean(raw.sealed),
      leaked: JSON.stringify(raw).includes('real-browser-sensitive-notes') ||
        JSON.stringify(raw).includes('real-browser.png')
    };
  }, scope);
  assert.deepEqual(first, {
    count: 1, notes: 'real-browser-sensitive-notes',
    hasKeyStore: true, sealed: true, leaked: false
  });
  console.log('PASS: Chromium migrates IndexedDB v1 -> v2 and encrypts photo + notes');

  await page.reload();
  const reopened = await page.evaluate(async (draftId) => {
    const { indexedDbQueueStore } = await import('/src/services/offlineQueueStore.js');
    return indexedDbQueueStore.get(draftId);
  }, id);
  assert.equal(reopened.body.operations[0].payload.notes, 'real-browser-sensitive-notes');
  assert.equal(reopened.evidence.original_name, 'real-browser.png');
  console.log('PASS: Chromium restores encrypted draft after tab reload');

  const storage = await page.evaluate(async () => {
    const { browserStorageStatus } = await import('/src/services/offlineStorageStatus.js');
    return browserStorageStatus();
  });
  assert.equal(storage.supported, true);
  console.log('PASS: Browser storage quota information available');

  // The actual browser decoder/canvas encoder handles a phone-sized image:
  // one oversized photo must be converted to a bounded JPEG before AES-GCM
  // encrypts it, and must survive a page reload with a stable client UUID.
  const camera = await page.evaluate(async () => {
    const { readOfflinePhoto } = await import('/src/services/offlinePhoto.js');
    const { offlineQueue } = await import('/src/services/offlineQueue.js');
    const canvas = document.createElement('canvas');
    canvas.width = 2200;
    canvas.height = 1700;
    const ctx = canvas.getContext('2d');
    const pixels = ctx.createImageData(canvas.width, canvas.height);
    let seed = 123456789;
    for (let index = 0; index < pixels.data.length; index += 4) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      pixels.data[index] = seed & 255;
      pixels.data[index + 1] = (seed >>> 8) & 255;
      pixels.data[index + 2] = (seed >>> 16) & 255;
      pixels.data[index + 3] = 255;
    }
    ctx.putImageData(pixels, 0, 0);
    const originalBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.98));
    if (!originalBlob) throw new Error('Could not generate test photo');
    const original = new File([originalBlob], 'original-field-camera.jpg', { type: 'image/jpeg' });
    const prepared = await readOfflinePhoto(original);
    const session = {
      token: 'browser-smoke-only',
      tenant: { id: '0b000000-0000-4000-8000-000000000001' },
      user: { id: '0b000000-0000-4000-8000-000000000002' }
    };
    const item = await offlineQueue.queueObservation(session,
      '0b000000-0000-4000-8000-000000000004',
      { notes: 'camera-smoke-test', observation_type: 'pest', severity: 'low', photo: prepared });
    return {
      originalBytes: original.size, savedBytes: prepared.size_bytes,
      resized: prepared.resized, mime: prepared.mime_type,
      name: prepared.original_name, queuedId: item.id,
      clientUploadId: item.evidence.client_upload_id
    };
  });
  assert.ok(camera.originalBytes > 512 * 1024, 'test camera source must exceed 512KiB');
  assert.ok(camera.savedBytes <= 512 * 1024);
  assert.equal(camera.resized, true);
  assert.equal(camera.mime, 'image/jpeg');
  assert.match(camera.name, /-reducida[.]jpg$/);
  assert.ok(camera.clientUploadId);
  await page.reload();
  const cameraReopened = await page.evaluate(async (draftId) => {
    const { offlineQueue } = await import('/src/services/offlineQueue.js');
    const session = {
      token: 'browser-smoke-only',
      tenant: { id: '0b000000-0000-4000-8000-000000000001' },
      user: { id: '0b000000-0000-4000-8000-000000000002' }
    };
    const item = (await offlineQueue.list(session)).find((row) => row.id === draftId);
    if (!item) return null;
    const response = {
      photoBytes: item.evidence.content_base64.length,
      clientUploadId: item.evidence.client_upload_id,
      observationHasPhoto: Boolean(item.body.operations[0].payload.content_base64)
    };
    await offlineQueue.discard(session, item.id);
    return response;
  }, camera.queuedId);
  assert.ok(cameraReopened.photoBytes > 0);
  assert.equal(cameraReopened.clientUploadId, camera.clientUploadId);
  assert.equal(cameraReopened.observationHasPhoto, false);
  console.log('PASS: Chromium compresses a camera JPEG and restores AES-GCM offline draft');
  await context.close();

  // Exercise production service-worker shell under a real offline reload.
  server.kill();
  server = run(process.execPath, [
    resolve(root, 'node_modules/vite/bin/vite.js'),
    'preview', '--host', '127.0.0.1', '--port', '4174', '--strictPort'
  ], 4174);
  await ready('http://127.0.0.1:4174/');
  const prod = await browser.newContext({ serviceWorkers: 'allow' });
  const prodPage = await prod.newPage();
  prodPage.on('pageerror', (error) => console.log('BROWSER_ERROR:', error.message));
  prodPage.on('requestfailed', (request) => console.log('FAILED_REQUEST:', request.url(), request.failure()?.errorText));
  await prodPage.goto('http://127.0.0.1:4174/', { waitUntil: 'load' });
  console.log('ONLINE_RENDER_LENGTH:', (await prodPage.locator('body').innerText()).length);
  await prodPage.evaluate(async () => navigator.serviceWorker.ready);
  await prodPage.waitForFunction(async () => {
    const cache = await caches.open('sedeagro-web-shell-v2');
    return Boolean(await cache.match('/'));
  });
  await prodPage.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  console.log('CACHED_URLS:', await prodPage.evaluate(async () => {
    const cache = await caches.open('sedeagro-web-shell-v2');
    return (await cache.keys()).map((request) => request.url);
  }));
  await prod.setOffline(true);
  await prodPage.reload({ waitUntil: 'domcontentloaded' });
  console.log('OFFLINE_RELOAD_URL:', prodPage.url());
  // DOMContentLoaded precedes React mounting and cached module evaluation.
  // Wait for meaningful UI, not just the empty root element in index.html.
  await prodPage.waitForFunction(() => document.body.innerText.trim().length > 10,
    null, { timeout: 10000 });
  assert.ok((await prodPage.locator('body').innerText()).length > 10);
  console.log('PASS: Chromium reopens production SPA offline using static-only SW');
  await prod.close();
} finally {
  if (browser) await browser.close();
  if (server) server.kill();
}
