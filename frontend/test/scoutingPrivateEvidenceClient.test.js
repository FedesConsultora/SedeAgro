import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseScoutingPrivateEvidence, isScoutingPreviewable } from '../src/services/scoutingPrivateEvidenceClient.js';

const ID = '53e8cf89-f6c6-4ce3-9785-91981f48f3d3';
const OTHER = '6c7ab98a-b5ed-4a28-801c-9fd6aa5c7bcb';
const bytes = Buffer.from('89504e470d0a1a0a00000000', 'hex');
const selected = Object.freeze({
  id: ID, original_name: 'lote-norte.png', mime_type: 'image/png', size_bytes: bytes.length
});
const reply = Object.freeze({
  data: { ...selected, content_base64: bytes.toString('base64') }
});

test('a selected private photo opens only when server ID, name, MIME and bytes match exactly', async () => {
  const result = parseScoutingPrivateEvidence(reply, selected);
  assert.equal(result.filename, selected.original_name);
  assert.equal(result.blob.type, selected.mime_type);
  assert.equal(result.blob.size, bytes.length);
  assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()), bytes);
  assert.equal(isScoutingPreviewable(selected), true);
  assert.equal(isScoutingPreviewable({ ...selected, mime_type: 'application/pdf' }), false);
});

test('PDF may be downloaded privately but never rendered as image preview', async () => {
  const pdf = Buffer.from('%PDF-1.4\n%%EOF\n');
  const asset = { ...selected, original_name: 'informe.pdf', mime_type: 'application/pdf', size_bytes: pdf.length };
  const { blob, filename } = parseScoutingPrivateEvidence({
    data: { ...asset, content_base64: pdf.toString('base64') }
  }, asset);
  assert.equal(filename, 'informe.pdf');
  assert.equal(blob.type, 'application/pdf');
});

test('scouting private preview rejects changed identity, names, MIME, length and data', () => {
  for (const changed of [
    { id: OTHER }, { original_name: 'otro.png' }, { mime_type: 'image/jpeg' },
    { size_bytes: bytes.length - 1 }, { size_bytes: String(bytes.length) },
    { content_base64: 'AA$=' }, { content_base64: 'AAAA=' },
    { content_base64: 'A'.repeat(2_796_208) }
  ]) {
    assert.throws(() => parseScoutingPrivateEvidence({
      data: { ...reply.data, ...changed }
    }, selected), /descarga privada|archivo seleccionado/i);
  }
  for (const changed of [
    { id: OTHER }, { original_name: 'otro.png' }, { mime_type: 'image/jpeg' },
    { size_bytes: bytes.length + 1 }, { original_name: '../archivo.png' },
    { original_name: 'mal\\archivo.png' }
  ]) {
    assert.throws(() => parseScoutingPrivateEvidence(reply, { ...selected, ...changed }),
      /descarga privada|archivo seleccionado/i);
  }
  assert.throws(() => parseScoutingPrivateEvidence(null, selected), /descarga privada/i);
  assert.throws(() => parseScoutingPrivateEvidence(reply, null), /descarga privada/i);
});

test('unsafe legacy filenames are rejected even if sender repeats them', () => {
  for (const name of ['../secret.png', 'carpeta\\secreto.png', '.', '..', '', '\u0000hidden.png']) {
    const asset = { ...selected, original_name: name };
    assert.throws(() => parseScoutingPrivateEvidence({
      data: { ...asset, content_base64: bytes.toString('base64') }
    }, asset), /descarga privada/i);
  }
});

const source = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('scouting viewer and download guard stale session/role/record and object URL cleanup', () => {
  const viewer = source('../src/components/EvidencePreviewModal.jsx');
  const page = source('../src/pages/ScoutingPage.jsx');
  assert.match(viewer, /parseScoutingPrivateEvidence\(/);
  assert.match(page, /parseScoutingPrivateEvidence\(/);
  assert.match(viewer, /sessionScope\(session\)/);
  assert.match(page, /sessionScope\(session\)/);
  assert.match(viewer, /requestSequence\.current/);
  assert.match(page, /downloadSequence\.current/);
  assert.match(viewer, /URL\.revokeObjectURL/);
  assert.match(page, /URL\.revokeObjectURL/);
  assert.match(viewer, /document\.addEventListener\('visibilitychange'/);
  assert.match(page, /window\.addEventListener\('offline'/);
  assert.match(page, /scopeRef\.current === downloadScope/);
  assert.doesNotMatch(viewer, /atob\(/);
  assert.doesNotMatch(page, /const binary = atob\(/);
});
