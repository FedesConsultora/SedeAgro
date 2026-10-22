import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPrivateUploadCache, preparePrivateEvidenceUpload } from '../src/services/privateEvidenceUpload.js';
import { MAX_CAMERA_SOURCE_BYTES } from '../src/services/offlinePhoto.js';
import { MAX_EXECUTION_FILE_BYTES } from '../src/services/executionEvidence.js';

const photo = { name: 'recorrida.png', type: 'image/png', size: 768 };
const prepared = {
  original_name: 'recorrida-reducida.jpg', mime_type: 'image/jpeg',
  size_bytes: 4, content_base64: '/9j/', sanitized: true
};

test('online photo upload sends only re-encoded JPEG, not original MIME, name or bytes', async () => {
  let called = 0;
  const result = await preparePrivateEvidenceUpload(photo, {
    sanitizePhoto: async selected => {
      assert.equal(selected, photo);
      called += 1;
      return prepared;
    }
  });
  assert.equal(called, 1);
  assert.deepEqual(result, {
    kind: 'photo', mime_type: 'image/jpeg',
    original_name: 'recorrida-reducida.jpg', content_base64: '/9j/'
  });
});

test('phone camera photos up to 12 MiB are sanitized before upload, never sent raw', async () => {
  for (const size of [MAX_EXECUTION_FILE_BYTES + 1, MAX_CAMERA_SOURCE_BYTES]) {
    const source = { ...photo, size };
    let sanitized = 0;
    const result = await preparePrivateEvidenceUpload(source, {
      sanitizePhoto: async selected => {
        assert.equal(selected, source);
        sanitized += 1;
        return prepared;
      },
      readDocument: async () => { throw new Error('No se deben leer bytes fuente de foto'); }
    });
    assert.equal(sanitized, 1);
    assert.equal(result.kind, 'photo');
    assert.equal(result.mime_type, 'image/jpeg');
    assert.equal(result.original_name, prepared.original_name);
    assert.equal(result.content_base64, prepared.content_base64);
  }
});

test('oversize, empty or unsafe camera images are rejected before decoder or HTTP', async () => {
  const invalidFiles = [
    { ...photo, size: MAX_CAMERA_SOURCE_BYTES + 1 },
    { ...photo, size: 0 },
    { ...photo, size: NaN },
    { ...photo, name: '../private.png' },
    { ...photo, name: 'bad\\\\name.png' }
  ];
  for (const file of invalidFiles) {
    let decoded = false;
    await assert.rejects(preparePrivateEvidenceUpload(file, {
      sanitizePhoto: async () => { decoded = true; return prepared; }
    }), /12 MiB|nombre|fotograf/i);
    assert.equal(decoded, false);
  }
  await assert.rejects(preparePrivateEvidenceUpload({ ...photo, size: MAX_CAMERA_SOURCE_BYTES,
    type: 'image/avif' }), /JPEG|PDF/);
});

test('online HEIC and HEIF from iPhone never reach upload as source MIME or bytes', async () => {
  for (const type of ['image/heic', 'image/heif']) {
    const file = { name: type === 'image/heic' ? 'camera.HEIC' : 'camera.heif',
      type, size: MAX_CAMERA_SOURCE_BYTES };
    let sanitized = 0;
    const payload = await preparePrivateEvidenceUpload(file, {
      sanitizePhoto: async selected => {
        assert.equal(selected, file);
        sanitized += 1;
        return { ...prepared, original_name: 'camera-reducida.jpg' };
      },
      readDocument: async () => { throw new Error('Raw HEIC cannot be read as document'); }
    });
    assert.equal(sanitized, 1);
    assert.deepEqual(payload, {
      kind: 'photo', mime_type: 'image/jpeg',
      original_name: 'camera-reducida.jpg', content_base64: prepared.content_base64
    });
    await assert.rejects(preparePrivateEvidenceUpload(file, {
      sanitizePhoto: async () => { throw new Error('Unsupported platform decoder'); }
    }), /Unsupported platform decoder/);
    await assert.rejects(preparePrivateEvidenceUpload(file, {
      sanitizePhoto: async () => ({
        ...prepared, mime_type: type, original_name: file.name
      })
    }), /JPEG sin metadatos/);
  }
});

test('photo conversion errors and unverified outputs fail closed without original fallback', async () => {
  for (const output of [null, { ...prepared, sanitized: false },
    { ...prepared, mime_type: 'image/png' },
    { ...prepared, size_bytes: 512 * 1024 + 1 },
    { ...prepared, content_base64: '' }]) {
    await assert.rejects(preparePrivateEvidenceUpload(photo, { sanitizePhoto: async () => output }),
      /JPEG sin metadatos/);
  }
  await assert.rejects(preparePrivateEvidenceUpload(photo, {
    sanitizePhoto: async () => { throw new Error('No se pudo decodificar'); }
  }), /No se pudo decodificar/);
});

test('PDF uploads keep original content and stay subject to the existing 2 MiB limit', async () => {
  const pdf = { name: 'parte.pdf', type: 'application/pdf', size: 13 };
  const result = await preparePrivateEvidenceUpload(pdf, {
    sanitizePhoto: async () => { throw new Error('No debe transformar PDF'); },
    readDocument: async selected => {
      assert.equal(selected, pdf);
      return 'JVBERi0xLjc=';
    }
  });
  assert.deepEqual(result, {
    kind: 'document', mime_type: 'application/pdf', original_name: 'parte.pdf',
    content_base64: 'JVBERi0xLjc='
  });
  await assert.rejects(preparePrivateEvidenceUpload({ ...pdf, size: MAX_EXECUTION_FILE_BYTES + 1 }),
    /2 MiB/);
  await assert.rejects(preparePrivateEvidenceUpload({ ...pdf, name: '../unsafe.pdf' }), /nombre/);
  await assert.rejects(preparePrivateEvidenceUpload({ ...pdf, size: MAX_CAMERA_SOURCE_BYTES }), /2 MiB/);
  await assert.rejects(preparePrivateEvidenceUpload({ ...photo, type: 'image/svg+xml' }), /JPEG/);
});

test('an ambiguous upload retry reuses the exact payload until selection/UUID changes', async () => {
  const cache = createPrivateUploadCache();
  let encodings = 0;
  const convert = async () => {
    encodings += 1;
    return { kind: 'photo', mime_type: 'image/jpeg',
      original_name: 'recorrida-reducida.jpg', content_base64: `encoder-run-${encodings}` };
  };
  const first = await cache.prepare(photo, 'attempt-1', convert);
  assert.equal(await cache.prepare(photo, 'attempt-1', convert), first);
  assert.equal(encodings, 1);
  assert.notEqual(await cache.prepare(photo, 'attempt-2', convert), first);
  assert.equal(encodings, 2);
  cache.reset();
  await cache.prepare(photo, 'attempt-2', convert);
  assert.equal(encodings, 3);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('two same-file same-UUID calls share ONE encoding before either one settles', async () => {
  const cache = createPrivateUploadCache();
  const converting = deferred();
  let conversions = 0;
  const prepare = () => { conversions += 1; return converting.promise; };
  const a = cache.prepare(photo, 'stable-uuid', prepare);
  const b = cache.prepare(photo, 'stable-uuid', prepare);
  await Promise.resolve();
  assert.equal(conversions, 1, 'concurrent submits must never encode different bytes under one UUID');
  const payload = { kind: 'photo', mime_type: 'image/jpeg',
    original_name: 'safe.jpg', content_base64: 'unique-JPEG-bytes' };
  converting.resolve(payload);
  const [first, second] = await Promise.all([a, b]);
  assert.equal(first, second);
  assert.equal(first, payload);
  assert.equal(await cache.prepare(photo, 'stable-uuid', prepare), payload);
  assert.equal(conversions, 1, 'ambiguous HTTP ACK must reuse the exact encoded bytes');
});

test('reset invalidates conversion in progress; stale JPEG cannot repopulate new scope cache', async () => {
  const cache = createPrivateUploadCache();
  const old = deferred();
  const pending = cache.prepare(photo, 'old-uuid', () => old.promise);
  const rejected = assert.rejects(pending, /cambió.*archivo|archivo.*cambió/i);
  await Promise.resolve();
  cache.reset();
  const otherFile = { ...photo, name: 'other.heic', type: 'image/heic' };
  const currentBytes = { kind: 'photo', mime_type: 'image/jpeg',
    original_name: 'other.jpg', content_base64: 'new-session-content' };
  let runs = 0;
  const current = await cache.prepare(otherFile, 'new-uuid', async () => {
    runs += 1; return currentBytes;
  });
  old.resolve({ kind: 'photo', mime_type: 'image/jpeg',
    original_name: 'old.jpg', content_base64: 'STALE-GPS-EXIF' });
  await rejected;
  assert.equal(await cache.prepare(otherFile, 'new-uuid', async () => {
    runs += 1; throw Error('Should not reencode new selection');
  }), current);
  assert.equal(runs, 1);
});

test('switching UUID mid-conversion invalidates old bytes without damaging the new one', async () => {
  const cache = createPrivateUploadCache();
  const old = deferred();
  const first = cache.prepare(photo, 'key-1', () => old.promise);
  const rejected = assert.rejects(first, /cambió.*archivo|archivo.*cambió/i);
  await Promise.resolve();
  const payload = await cache.prepare(photo, 'key-2', async () => ({
    kind: 'photo', mime_type: 'image/jpeg',
    original_name: 'fresh.jpg', content_base64: 'fresh' }));
  old.resolve({ kind: 'photo', mime_type: 'image/jpeg',
    original_name: 'stale.jpg', content_base64: 'stale' });
  await rejected;
  assert.equal(await cache.prepare(photo, 'key-2', async () => {
    throw new Error('Wrong cache key');
  }), payload);
});

test('failed decoder is not cached and may retry; invalid selection never calls converter', async () => {
  const cache = createPrivateUploadCache();
  let calls = 0;
  await assert.rejects(cache.prepare(photo, 'retry-uuid', async () => {
    calls += 1; throw new Error('Decoder failed');
  }), /Decoder failed/);
  const payload = await cache.prepare(photo, 'retry-uuid', async () => {
    calls += 1; return { kind: 'photo', content_base64: 'sanitized' };
  });
  assert.equal(calls, 2);
  assert.equal((await cache.prepare(photo, 'retry-uuid')).content_base64, payload.content_base64);
  await assert.rejects(cache.prepare(null, 'retry-uuid', () => {
    throw new Error('Must not run');
  }), /Seleccioná/);
});

test('both live upload surfaces must use the shared privacy gate, never FileReader images', () => {
  for (const path of ['../src/components/EvidenceUploadModal.jsx',
    '../src/components/WorkOrderExecutionEvidence.jsx']) {
    const jsx = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(jsx, /preparePrivateEvidenceUpload|createPrivateUploadCache/);
    assert.match(jsx, /client_upload_id: uploadKey/);
    assert.match(jsx, /uploadCache\.current\.prepare\(file, uploadKey\)/);
    assert.match(jsx, /createMobileCaptureFence/);
    assert.match(jsx, /const uploadInFlight = useRef\(null\)/);
    assert.match(jsx, /isCurrent\(uploadInFlight\.current\)/);
    assert.match(jsx, /uploadInFlight\.current === ticket/);
    assert.doesNotMatch(jsx, /readAsDataURL\(file\)/);
  }
});
