import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_CAMERA_SOURCE_BYTES, MAX_CAMERA_PIXELS, MAX_OFFLINE_PHOTO_BYTES,
  cameraPhotoPlan, photoOutputName, scaledPhotoSize, validateOfflinePhoto
} from '../src/services/offlinePhoto.js';
import { guidanceForDraft, queueSummary } from '../src/services/offlineConflictGuidance.js';

test('field camera accepts compatible 12MiB sources but preserves the 512KiB encrypted draft cap', () => {
  assert.deepEqual(cameraPhotoPlan({
    name: 'campo.jpg', type: 'image/jpeg', size: MAX_OFFLINE_PHOTO_BYTES
  }), { compress: false, sourceBytes: MAX_OFFLINE_PHOTO_BYTES });
  assert.deepEqual(cameraPhotoPlan({
    name: 'campo.png', type: 'image/png', size: MAX_CAMERA_SOURCE_BYTES
  }), { compress: true, sourceBytes: MAX_CAMERA_SOURCE_BYTES });
  assert.throws(() => cameraPhotoPlan({
    name: 'huge.jpg', type: 'image/jpeg', size: MAX_CAMERA_SOURCE_BYTES + 1
  }), /12 MiB/i);
  assert.throws(() => cameraPhotoPlan({
    name: '../outside.jpg', type: 'image/jpeg', size: 10
  }), /nombre/i);
  assert.throws(() => cameraPhotoPlan({
    name: 'photo.heic', type: 'image/heic', size: 1024
  }), /JPEG, PNG o WebP/i);
  assert.throws(() => cameraPhotoPlan({
    name: 'photo.svg', type: 'image/svg+xml', size: 1024
  }), /JPEG, PNG o WebP/i);
});

test('resizing is bounded, preserves aspect ratio, and never enlarges an image', () => {
  assert.deepEqual(scaledPhotoSize(4000, 3000, 2048), { width: 2048, height: 1536 });
  assert.deepEqual(scaledPhotoSize(3000, 4000, 1024), { width: 768, height: 1024 });
  assert.deepEqual(scaledPhotoSize(640, 480, 2048), { width: 640, height: 480 });
  assert.throws(() => scaledPhotoSize(10000, 10000, 2048), /40 megapíxeles/i);
  assert.throws(() => scaledPhotoSize(0, 10, 2048), /40 megapíxeles/i);
  assert.ok(MAX_CAMERA_PIXELS < 100_000_000);
});

test('compressed upload filenames remain backend-safe, small and distinct from originals', () => {
  const name = photoOutputName('lote norte (foto) 2026.png');
  assert.match(name, /^[a-zA-Z0-9_-]+\.jpg$/);
  assert.ok(name.length <= 180);
  assert.ok(photoOutputName('á'.repeat(250) + '.webp').length <= 180);
  assert.match(photoOutputName('.png'), /-reducida\.jpg$/);
  assert.throws(() => validateOfflinePhoto({
    original_name: '../../hidden.png', mime_type: 'image/png',
    content_base64: 'iVBORw0KGgoAAA=='
  }), /nombre/i);
});

test('sync guidance acknowledges photos only after the observation was confirmed', () => {
  const pending = { id: '1', state: 'pending', evidence: { original_name: 'photo.jpg' } };
  const partial = { ...pending, syncedObservationId: 'server-observation-id',
    state: 'conflict', errorCode: 'SCOUTING_RUN_CLOSED',
    lastError: 'recorrida cerrada' };
  assert.equal(guidanceForDraft(pending).phase, 'observation');
  assert.equal(guidanceForDraft(partial).phase, 'photo');
  assert.match(guidanceForDraft(partial).heading, /confirmada/i);
  assert.match(guidanceForDraft(partial).description, /coordinador/i);
  assert.equal(guidanceForDraft(partial).tone, 'warning');
  assert.equal(guidanceForDraft({ ...partial, state: 'auth' }).phase, 'photo');
  assert.match(guidanceForDraft({ ...partial, state: 'auth' }).description, /Iniciá sesión/i);
  assert.equal(guidanceForDraft({ ...partial, errorCode: 'UNKNOWN_CODE' }).phase, 'photo');
  assert.deepEqual(queueSummary([pending, partial, { state: 'auth' }]), {
    pending: 1, review: 2, photoOnly: 1, total: 3
  });
});
