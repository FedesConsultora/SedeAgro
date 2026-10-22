import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPrivateUploadCache, preparePrivateEvidenceUpload } from '../src/services/privateEvidenceUpload.js';

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
  await assert.rejects(preparePrivateEvidenceUpload({ ...pdf, size: 2 * 1024 * 1024 + 1 }),
    /2 MiB/);
  await assert.rejects(preparePrivateEvidenceUpload({ ...pdf, name: '../unsafe.pdf' }), /nombre/);
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

test('both live upload surfaces must use the shared privacy gate, never FileReader images', () => {
  for (const path of ['../src/components/EvidenceUploadModal.jsx',
    '../src/components/WorkOrderExecutionEvidence.jsx']) {
    const jsx = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(jsx, /preparePrivateEvidenceUpload|createPrivateUploadCache/);
    assert.doesNotMatch(jsx, /readAsDataURL\(file\)/);
  }
});
