import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeEvidenceContent, safeEvidenceFileName, MAX_EVIDENCE_BYTES } from '../src/modules/scouting/evidenceContent.js';
import { canReadScoutingRun, assertScoutingWritable, assertRunTransition } from '../src/modules/scouting/scoutingPolicy.js';

const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
const jpg = Buffer.from('ffd8ffdb0000000000', 'hex');
const pdf = Buffer.from('%PDF-1.7\nminimal fixture');
const img = (bytes, mime_type, kind = 'photo') => ({
  kind, mime_type, content_base64: bytes.toString('base64')
});

test('evidence accepts a real image or PDF with verified header, never MIME spoofing', () => {
  assert.deepEqual(decodeEvidenceContent(img(png, 'image/png')), png);
  assert.deepEqual(decodeEvidenceContent(img(jpg, 'image/jpeg')), jpg);
  assert.deepEqual(decodeEvidenceContent(img(pdf, 'application/pdf', 'document')), pdf);
  for (const input of [
    img(pdf, 'image/jpeg'), img(png, 'image/svg+xml'), img(png, 'image/png', 'document'),
    img(Buffer.from('malware'), 'application/pdf', 'document'),
    { kind: 'photo', mime_type: 'image/jpeg', content_base64: 'not-base64!' },
    { kind: 'photo', mime_type: 'image/jpeg', content_base64: 'x'.repeat(3000000) },
    img(Buffer.concat([jpg, Buffer.alloc(MAX_EVIDENCE_BYTES)]), 'image/jpeg')
  ]) {
    assert.throws(() => decodeEvidenceContent(input), /contenido|formato|fotografías/i);
  }
});

test('evidence filenames cannot contain path traversal, controls or directory separators', () => {
  assert.equal(safeEvidenceFileName('lote-norte.jpg'), 'lote-norte.jpg');
  for (const input of ['../evil.pdf', 'a/b.pdf', 'a\\b.pdf', '..', '.', 'bad\x00name', '', 'a'.repeat(181)]) {
    assert.throws(() => safeEvidenceFileName(input), /archivo inválido/i);
  }
});

test('scouts can read and write only their assigned active runs', () => {
  const scout = { role: { code: 'scout' }, user: { id: 'a' } };
  const admin = { role: { code: 'tenant_admin' }, user: { id: 'b' } };
  const assigned = { assigned_to: 'a', status: 'in_progress' };
  assert.equal(canReadScoutingRun(scout, assigned), true);
  assert.equal(canReadScoutingRun(scout, { ...assigned, assigned_to: 'b' }), false);
  assert.equal(canReadScoutingRun(admin, { ...assigned, assigned_to: 'b' }), true);
  assert.doesNotThrow(() => assertScoutingWritable(scout, assigned));
  assert.throws(() => assertScoutingWritable(scout, { ...assigned, assigned_to: 'b' }), /no encontrada/i);
  assert.throws(() => assertScoutingWritable(scout, { ...assigned, status: 'completed' }), /cerrada/i);
});

test('run state machine rejects skipped and terminal transitions', () => {
  assert.doesNotThrow(() => assertRunTransition('planned', 'in_progress'));
  assert.doesNotThrow(() => assertRunTransition('in_progress', 'completed'));
  assert.throws(() => assertRunTransition('planned', 'completed'), /transición/i);
  assert.throws(() => assertRunTransition('completed', 'in_progress'), /transición/i);
  assert.throws(() => assertRunTransition('constructor', 'in_progress'), /transición/i);
});
