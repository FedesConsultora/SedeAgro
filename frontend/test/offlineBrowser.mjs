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

  // Upgraded installations must scrub the old JWT-bearing localStorage key.
  await page.evaluate(() => localStorage.setItem('sedeagro.session', JSON.stringify({
    token: 'legacy-sensitive-jwt-never-persist', tenant: { id: 'old-tenant' }
  })));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => localStorage.getItem('sedeagro.session') === null);
  assert.equal(await page.evaluate(() => localStorage.getItem('sedeagro.session')), null);
  console.log('PASS: Browser removes legacy localStorage JWT before rendering');

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

  // 0S.10: use two independent real Chromium tabs sharing the same IndexedDB.
  // The second tab's decrypted object is stale after the first tab updates,
  // even when the encrypted row remains in the same DB and key store.
  const otherTab = await context.newPage();
  await otherTab.goto('http://127.0.0.1:4173/');
  await otherTab.evaluate(async (draftId) => {
    const { indexedDbQueueStore } = await import('/src/services/offlineQueueStore.js');
    window.__staleOfflineDraft = await indexedDbQueueStore.get(draftId);
  }, id);
  const firstWrite = await page.evaluate(async (draftId) => {
    const { indexedDbQueueStore } = await import('/src/services/offlineQueueStore.js');
    const read = await indexedDbQueueStore.get(draftId);
    return indexedDbQueueStore.put({ ...read, lastError: 'updated from tab A' }, { expected: read });
  }, id);
  assert.equal(firstWrite, true);
  const stale = await otherTab.evaluate(async (draftId) => {
    const { indexedDbQueueStore } = await import('/src/services/offlineQueueStore.js');
    const old = window.__staleOfflineDraft;
    const lostDelete = await indexedDbQueueStore.delete(draftId, { expected: old });
    const lostWrite = await indexedDbQueueStore.put({
      ...old, lastError: 'stale tab B write'
    }, { expected: old });
    const current = await indexedDbQueueStore.get(draftId);
    return {
      lostDelete, lostWrite, lastError: current.lastError,
      photoStillThere: Boolean(current.evidence?.content_base64),
      revisionWasEncrypted: current.body.operations[0].payload.notes ===
        'real-browser-sensitive-notes'
    };
  }, id);
  assert.deepEqual(stale, {
    lostDelete: false, lostWrite: false, lastError: 'updated from tab A',
    photoStillThere: true, revisionWasEncrypted: true
  });
  const freshDelete = await otherTab.evaluate(async (draftId) => {
    const { indexedDbQueueStore } = await import('/src/services/offlineQueueStore.js');
    const current = await indexedDbQueueStore.get(draftId);
    return indexedDbQueueStore.delete(draftId, { expected: current });
  }, id);
  assert.equal(freshDelete, true);
  assert.equal(await page.evaluate(async (draftId) => {
    const { indexedDbQueueStore } = await import('/src/services/offlineQueueStore.js');
    return indexedDbQueueStore.get(draftId);
  }, id), undefined);
  await otherTab.close();
  console.log('PASS: Two Chromium tabs reject stale CAS write/delete while preserving encrypted draft');


  // 0U.15: Count+insert must be serialized in one IDB readwrite
  // transaction. Both independent tabs submit at the 99/100 boundary.
  const quota = await page.evaluate(async () => {
    const { indexedDbQueueStore } = await import('/src/services/offlineQueueStore.js');
    const { createPendingObservation } = await import('/src/services/offlineSyncModel.js');
    const account = {
      authenticated: true,
      tenant: { id: '0c000000-0000-4000-8000-000000000001' },
      user: { id: '0c000000-0000-4000-8000-000000000002' }
    };
    const make = (n) => {
      let position = 0;
      return createPendingObservation({
        session: account, runId: '0c000000-0000-4000-8000-000000000003',
        values: { observation_type: 'pest', severity: 'low',
          notes: 'private quota test ' + String(n) },
        uuid: () => '0c000000-0000-4000-8000-' +
          String(n * 3 + ++position).padStart(12, '0'),
        now: new Date('2026-10-14T12:00:00.000Z')
      });
    };
    for (let n = 0; n < 99; n++) await indexedDbQueueStore.put(make(n));
    return { scope: make(0).scope, first: make(99), second: make(100) };
  });
  const quotaTab = await context.newPage();
  await quotaTab.goto('http://127.0.0.1:4173/');
  const putCandidate = async (target, draft) => target.evaluate(async (row) => {
    const { indexedDbQueueStore } = await import('/src/services/offlineQueueStore.js');
    try { return { accepted: await indexedDbQueueStore.put(row) === row.id }; }
    catch (error) { return { accepted: false, error: error.message }; }
  }, draft);
  const raced = await Promise.all([
    putCandidate(page, quota.first),
    putCandidate(quotaTab, quota.second)
  ]);
  assert.equal(raced.filter(row => row.accepted).length, 1);
  assert.equal(raced.filter(row => !row.accepted).length, 1);
  assert.match(raced.find(row => !row.accepted).error, /límite de 100/);
  await page.reload();
  const quotaCheck = await page.evaluate(async ({ scope, first }) => {
    const { indexedDbQueueStore } = await import('/src/services/offlineQueueStore.js');
    const rows = await indexedDbQueueStore.list(scope);
    const full = rows.length;
    const current = await indexedDbQueueStore.get(rows[0].id);
    const updated = await indexedDbQueueStore.put({
      ...current, lastError: 'updated at 100 without adding row'
    }, { expected: current });
    const otherScope = '0c000000-0000-4000-8000-000000000009:' +
      '0c000000-0000-4000-8000-000000000002';
    const other = { ...first, scope: otherScope,
      id: otherScope + ':' + first.idempotencyKey };
    await indexedDbQueueStore.put(other);
    const otherCount = (await indexedDbQueueStore.list(otherScope)).length;
    return {
      full, updated, otherCount,
      afterUpdate: (await indexedDbQueueStore.list(scope)).length,
      otherIsolated: (await indexedDbQueueStore.list(otherScope))[0].scope === otherScope
    };
  }, quota);
  assert.deepEqual(quotaCheck, {
    full: 100, updated: true, otherCount: 1,
    afterUpdate: 100, otherIsolated: true
  });
  await quotaTab.close();
  console.log('PASS: Two Chromium tabs enforce a 100-draft scoped cap atomically; CAS and other tenants unaffected');

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

  // EXIF/GPS bytes in an already-small JPEG must never enter a NEW draft.
  // Insert a syntactically valid APP1 segment with a sentinel GPS label.
  const exifCheck = await page.evaluate(async () => {
    const { readOfflinePhoto } = await import('/src/services/offlinePhoto.js');
    const c = document.createElement('canvas');
    c.width = 32; c.height = 24;
    c.getContext('2d').fillRect(0, 0, c.width, c.height);
    const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.8));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const tag = new TextEncoder().encode('Exif\\0\\0GPSLatitude=SEDEAGRO_PRIVATE_LOCATION');
    const segmentLength = tag.length + 2;
    const tagged = new Uint8Array(bytes.length + 4 + tag.length);
    tagged.set(bytes.slice(0, 2), 0);
    tagged[2] = 0xff; tagged[3] = 0xe1;
    tagged[4] = (segmentLength >>> 8) & 255;
    tagged[5] = segmentLength & 255;
    tagged.set(tag, 6);
    tagged.set(bytes.slice(2), 6 + tag.length);
    const source = new File([tagged], 'small-with-gps.jpg', { type: 'image/jpeg' });
    const saved = await readOfflinePhoto(source);
    const raw = atob(saved.content_base64);
    return {
      sourceBytes: source.size,
      mimeType: saved.mime_type,
      sanitized: saved.sanitized,
      filename: saved.original_name,
      hasGps: raw.includes('SEDEAGRO_PRIVATE_LOCATION'),
      hasExif: raw.includes('Exif')
    };
  });
  assert.ok(exifCheck.sourceBytes < 512 * 1024);
  assert.equal(exifCheck.mimeType, 'image/jpeg');
  assert.equal(exifCheck.sanitized, true);
  assert.equal(exifCheck.hasGps, false);
  assert.equal(exifCheck.hasExif, false);
  assert.match(exifCheck.filename, /-reducida[.]jpg$/);
  console.log('PASS: Chromium strips embedded location marker from small JPEG during re-encoding');
  await context.close();

  // 0T.2: simulate an iPhone-like viewport and a browser where
  // createImageBitmap is missing. This tests fallback behavior in Chromium,
  // NOT actual iOS/WebKit hardware acceptance.
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 3,
    isMobile: true, hasTouch: true
  });
  const mobilePage = await mobile.newPage();
  await mobilePage.goto('http://127.0.0.1:4173/');
  const mobileCapture = await mobilePage.evaluate(async () => {
    const { readOfflinePhoto } = await import('/src/services/offlinePhoto.js');
    const { offlineQueue } = await import('/src/services/offlineQueue.js');
    const oldBitmap = Object.getOwnPropertyDescriptor(window, 'createImageBitmap');
    Object.defineProperty(window, 'createImageBitmap', { configurable: true, value: undefined });
    const sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = 128;
    sourceCanvas.height = 64;
    sourceCanvas.getContext('2d').fillRect(0, 0, 128, 64);
    const blob = await new Promise(resolve => sourceCanvas.toBlob(resolve, 'image/jpeg', 0.9));
    if (!blob) throw new Error('Could not create mobile test photo');
    const originalBytes = new Uint8Array(await blob.arrayBuffer());
    const gps = new TextEncoder().encode('Exif\\0\\0GPSLatitude=PRIVATE-MOBILE-FALLBACK');
    const tagged = new Uint8Array(originalBytes.length + 4 + gps.length);
    tagged.set(originalBytes.slice(0, 2));
    tagged[2] = 0xff; tagged[3] = 0xe1;
    tagged[4] = (gps.length + 2) >>> 8;
    tagged[5] = (gps.length + 2) & 255;
    tagged.set(gps, 6);
    tagged.set(originalBytes.slice(2), 6 + gps.length);
    const file = new File([tagged], 'mobile-private-gps.jpg', { type: 'image/jpeg' });

    let revoked = 0;
    const originalRevoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url) => { revoked += 1; originalRevoke(url); };
    let prepared;
    try {
      prepared = await readOfflinePhoto(file);
    } finally {
      URL.revokeObjectURL = originalRevoke;
      if (oldBitmap) Object.defineProperty(window, 'createImageBitmap', oldBitmap);
      else delete window.createImageBitmap;
    }
    const decoded = atob(prepared.content_base64);
    const session = {
      token: 'test-only', tenant: { id: '0c000000-0000-4000-8000-000000000001' },
      user: { id: '0c000000-0000-4000-8000-000000000002' }
    };
    const draft = await offlineQueue.queueObservation(
      session, '0c000000-0000-4000-8000-000000000003',
      { notes: 'MOBILE-PRIVATE-DRAFT', observation_type: 'weed',
        severity: 'low', photo: prepared }
    );
    return {
      id: draft.id, scope: draft.scope, clientUploadId: draft.evidence.client_upload_id,
      photoMime: prepared.mime_type, size: prepared.size_bytes,
      sanitized: prepared.sanitized, revoked,
      exifLeaked: decoded.includes('Exif') || decoded.includes('PRIVATE-MOBILE-FALLBACK')
    };
  });
  assert.equal(mobileCapture.photoMime, 'image/jpeg');
  assert.equal(mobileCapture.sanitized, true);
  assert.ok(mobileCapture.size > 0 && mobileCapture.size <= 512 * 1024);
  assert.equal(mobileCapture.exifLeaked, false);
  assert.equal(mobileCapture.revoked, 1);
  console.log('PASS: simulated mobile WebKit fallback sanitized a fresh JPEG without createImageBitmap');
  await mobilePage.reload();
  const persistedMobile = await mobilePage.evaluate(async (id) => {
    const { indexedDbQueueStore } = await import('/src/services/offlineQueueStore.js');
    const draft = await indexedDbQueueStore.get(id);
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('sedeagro-offline-sync', 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const raw = await new Promise((resolve, reject) => {
      const tx = db.transaction('pending-observations', 'readonly');
      const request = tx.objectStore('pending-observations').get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return {
      encrypted: Boolean(raw?.sealed),
      leaked: JSON.stringify(raw).includes('MOBILE-PRIVATE-DRAFT') ||
        JSON.stringify(raw).includes('PRIVATE-MOBILE-FALLBACK'),
      photo: Boolean(draft?.evidence?.content_base64),
      clientUploadId: draft?.evidence?.client_upload_id
    };
  }, mobileCapture.id);
  assert.deepEqual(persistedMobile, {
    encrypted: true, leaked: false, photo: true,
    clientUploadId: mobileCapture.clientUploadId
  });
  console.log('PASS: mobile fallback photo persisted encrypted and reopened on reload');
  await mobile.close();

  // Earlier sections intentionally closed their browser context. Campaign
  // recovery uses its own origin-isolated Chromium context for both tabs.
  const campaignContext = await browser.newContext();
  const campaignPage = await campaignContext.newPage();
  await campaignPage.goto('http://127.0.0.1:4173/');

  // Pilot campaign recovery: real WebCrypto + IndexedDB, reload, two tabs
  // and byte inspection. A manual retry must preserve the original UUID.
  const campaignRecoveryInput = {
    scope: JSON.stringify(['tenant-a:user-a', 'member-a', 'tenant_admin', ['campaigns']]),
    otherScope: JSON.stringify(['tenant-b:user-b', 'member-b', 'tenant_admin', ['campaigns']]),
    body: {
      client_request_id: '9b000000-0000-4000-8000-000000000001',
      name: 'PRIVATE-CAMPAIGN-NAME-NEVER-IN-PLAINTEXT',
      season_year: 2026, starts_at: '2026-09-01', ends_at: '2027-06-30',
      status: 'planned'
    }
  };
  const savedCampaign = await campaignPage.evaluate(async ({scope, body}) => {
    const service = await import('/src/services/campaignRecoveryStore.js');
    await service.saveCampaignRecovery(scope, body);
    const row = await service.readCampaignRecovery(scope);
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('sedeagro-campaign-recovery', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const raw = await new Promise((resolve, reject) => {
      const tx = db.transaction('pending-creates', 'readonly');
      const req = tx.objectStore('pending-creates').get(scope);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return {
      key: row.body.client_request_id, name: row.body.name,
      encrypted: raw.ciphertext instanceof ArrayBuffer,
      leaked: JSON.stringify(raw).includes(body.name)
    };
  }, campaignRecoveryInput);
  assert.deepEqual(savedCampaign, {
    key: campaignRecoveryInput.body.client_request_id,
    name: campaignRecoveryInput.body.name, encrypted: true, leaked: false
  });
  await campaignPage.reload({ waitUntil: 'domcontentloaded' });
  const afterCampaignReload = await campaignPage.evaluate(async ({scope,otherScope,body}) => {
    const service = await import('/src/services/campaignRecoveryStore.js');
    const restored = await service.readCampaignRecovery(scope);
    return { body: restored.body, foreign: await service.readCampaignRecovery(otherScope) };
  }, campaignRecoveryInput);
  assert.deepEqual(afterCampaignReload.body, campaignRecoveryInput.body);
  assert.equal(afterCampaignReload.foreign, null);
  console.log('PASS: encrypted campaign replay body/UUID survives real reload, foreign scope sealed');

  const campaignTab = await campaignContext.newPage();
  await campaignTab.goto('http://127.0.0.1:4173/');
  const fromOtherTab = await campaignTab.evaluate(async scope => {
    const service = await import('/src/services/campaignRecoveryStore.js');
    return (await service.readCampaignRecovery(scope)).body.client_request_id;
  }, campaignRecoveryInput.scope);
  assert.equal(fromOtherTab, campaignRecoveryInput.body.client_request_id);
  const staleDelete = await campaignTab.evaluate(async ({scope}) => {
    const service = await import('/src/services/campaignRecoveryStore.js');
    return service.discardCampaignRecovery(scope, '9b000000-0000-4000-8000-000000000099');
  }, campaignRecoveryInput);
  assert.equal(staleDelete, false);
  await assert.rejects(
    campaignPage.evaluate(async ({scope,body}) => {
      const service = await import('/src/services/campaignRecoveryStore.js');
      return service.saveCampaignRecovery(scope, {...body,
        client_request_id: '9b000000-0000-4000-8000-000000000002'});
    }, campaignRecoveryInput), /pendiente/);
  const originalGone = await campaignTab.evaluate(async ({scope,body}) => {
    const service = await import('/src/services/campaignRecoveryStore.js');
    return service.discardCampaignRecovery(scope, body.client_request_id);
  }, campaignRecoveryInput);
  assert.equal(originalGone, true);

  const race = await Promise.allSettled([
    campaignPage.evaluate(async ({scope,body}) => {
      const service = await import('/src/services/campaignRecoveryStore.js');
      return service.saveCampaignRecovery(scope, {
        ...body, client_request_id: '9b000000-0000-4000-8000-000000000003',
        name: 'CAMPAIGN-TAB-A-PRIVATE'
      });
    }, campaignRecoveryInput),
    campaignTab.evaluate(async ({scope,body}) => {
      const service = await import('/src/services/campaignRecoveryStore.js');
      return service.saveCampaignRecovery(scope, {
        ...body, client_request_id: '9b000000-0000-4000-8000-000000000004',
        name: 'CAMPAIGN-TAB-B-PRIVATE'
      });
    }, campaignRecoveryInput)
  ]);
  assert.deepEqual(race.map(x=>x.status).sort(), ['fulfilled','rejected'],
    'only one browser tab may reserve an uncertain campaign slot');
  const campaignRaceBody = await campaignPage.evaluate(async scope => {
    const service = await import('/src/services/campaignRecoveryStore.js');
    return (await service.readCampaignRecovery(scope)).body;
  }, campaignRecoveryInput.scope);
  assert.ok(['CAMPAIGN-TAB-A-PRIVATE','CAMPAIGN-TAB-B-PRIVATE'].includes(campaignRaceBody.name));
  console.log('PASS: concurrent tabs cannot overwrite pending creation or discard wrong UUID');

  await campaignTab.close();
  await campaignContext.close();

  // Cross-module recovery: scouting creates have their OWN DB and key space,
  // so a pending campaign never conceals a field operation or vice versa.
  const runCtx = await browser.newContext();
  const runPage = await runCtx.newPage();
  await runPage.goto('http://127.0.0.1:4173/');
  const runScope = JSON.stringify(['tenant-c:user-c','membership-c','tenant_admin',['scouting']]);
  const foreignRunScope = JSON.stringify(['tenant-d:user-d','membership-d','tenant_admin',['scouting']]);
  const runBody = {
    client_request_id: '9c000000-0000-4000-8000-000000000001',
    campaign_field_id: '9c000000-0000-4000-8000-000000000002',
    assigned_to: '9c000000-0000-4000-8000-000000000003',
    scheduled_at: '2026-10-26T17:30:00.000Z', status: 'in_progress',
    summary: 'PRIVATE-RUN-DETAILS-FOR-FIELD-TEAM'
  };
  const firstRun = await runPage.evaluate(async ({scope, body, otherScope}) => {
    const runs = await import('/src/services/scoutingRunRecoveryStore.js');
    const campaigns = await import('/src/services/campaignRecoveryStore.js');
    await runs.saveScoutingRunRecovery(scope, body);
    const read = await runs.readScoutingRunRecovery(scope);
    const other = await runs.readScoutingRunRecovery(otherScope);
    const campaign = await campaigns.readCampaignRecovery(scope);
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('sedeagro-scouting-run-recovery', 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const raw = await new Promise((resolve, reject) => {
      const req = db.transaction('pending-creates','readonly')
        .objectStore('pending-creates').get(scope);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return {
      body: read.body, other, campaign,
      sealed: raw.ciphertext instanceof ArrayBuffer,
      leaked: JSON.stringify(raw).includes(body.summary)
    };
  }, {scope:runScope,body:runBody,otherScope:foreignRunScope});
  assert.deepEqual(firstRun, {body:runBody,other:null,campaign:null,sealed:true,leaked:false});
  await runPage.reload({waitUntil:'domcontentloaded'});
  const reloadedRun = await runPage.evaluate(async scope => {
    const {readScoutingRunRecovery} = await import('/src/services/scoutingRunRecoveryStore.js');
    return (await readScoutingRunRecovery(scope)).body;
  },runScope);
  assert.deepEqual(reloadedRun,runBody);
  const runSecondTab = await runCtx.newPage();
  await runSecondTab.goto('http://127.0.0.1:4173/');
  const wrongDiscard = await runSecondTab.evaluate(async scope => {
    const {discardScoutingRunRecovery} = await import('/src/services/scoutingRunRecoveryStore.js');
    return discardScoutingRunRecovery(scope, '9c000000-0000-4000-8000-000000000099');
  }, runScope);
  assert.equal(wrongDiscard,false);
  const oldRunBody = await runSecondTab.evaluate(async scope => {
    const {readScoutingRunRecovery} = await import('/src/services/scoutingRunRecoveryStore.js');
    return (await readScoutingRunRecovery(scope)).body;
  },runScope);
  assert.deepEqual(oldRunBody,runBody);
  await assert.rejects(runSecondTab.evaluate(async ({scope,body}) => {
    const {saveScoutingRunRecovery} = await import('/src/services/scoutingRunRecoveryStore.js');
    return saveScoutingRunRecovery(scope, {...body,
      client_request_id: '9c000000-0000-4000-8000-000000000004'});
  },{scope:runScope,body:runBody}),/pendiente/);
  const deletedRun = await runSecondTab.evaluate(async ({scope,id}) => {
    const {discardScoutingRunRecovery} = await import('/src/services/scoutingRunRecoveryStore.js');
    return discardScoutingRunRecovery(scope,id);
  },{scope:runScope,id:runBody.client_request_id});
  assert.equal(deletedRun,true);
  await runSecondTab.close();
  await runCtx.close();
  console.log('PASS: scouting run encrypted UUID survives reload; tabs and campaigns remain isolated');

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
