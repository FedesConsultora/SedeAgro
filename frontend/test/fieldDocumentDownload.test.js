import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFieldDocument } from '../src/services/reportDownload.js';
import { readFileSync } from 'node:fs';

const content = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const api = content('../src/services/api.js');
const reportCard = content('../src/components/FieldReportCard.jsx');

function payload(format, bytes) {
  return {
    mimeType: format === 'pdf' ? 'application/pdf' :
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    content_base64: Buffer.from(bytes).toString('base64'),
    size_bytes: bytes.length,
    counts: { observations: 1, workOrders: 2 }
  };
}
test('PDF and XLSX response decoder validates signatures and bytes', async () => {
  const pdf = decodeFieldDocument(payload('pdf', Buffer.from('%PDF-1.4 text')), 'pdf');
  assert.equal(pdf.blob.type, 'application/pdf');
  assert.equal(pdf.blob.size, 13);
  assert.deepEqual(pdf.counts, { observations: 1, workOrders: 2 });
  const xlsx = decodeFieldDocument(payload('xlsx', Buffer.from([80,75,3,4,10,0])), 'xlsx');
  assert.equal(xlsx.blob.size, 6);
  assert.match(xlsx.blob.type, /spreadsheetml/);
});
test('mismatched MIME, damaged files and too-large payloads block downloads', () => {
  assert.throws(() => decodeFieldDocument(payload('pdf', Buffer.from([80,75,3,4])), 'pdf'), /firma inválida/);
  assert.throws(() => decodeFieldDocument(payload('pdf', Buffer.from('%PDF-1.4')), 'xlsx'), /inválida/);
  assert.throws(() => decodeFieldDocument({ ...payload('pdf', Buffer.from('%PDF-1.4')),
    size_bytes: 100 }, 'pdf'), /tamaño inesperado/);
  assert.throws(() => decodeFieldDocument({ ...payload('pdf', Buffer.from('%PDF-1.4')),
    content_base64: '!NOT BASE64!' }, 'pdf'), /codificación válida/);
  assert.throws(() => decodeFieldDocument({ ...payload('pdf', Buffer.from('%PDF-1.4')),
    size_bytes: 4 * 1024 * 1024 }, 'pdf'), /inválida/);
});
test('same cookie-authenticated session/tenant fences all three formats', () => {
  assert.match(api, /exportFieldDocument: \(fieldId, format/);
  assert.match(api, /!\['pdf', 'xlsx'\]\.includes\(format\)/);
  assert.match(reportCard, /api\.exportFieldDocument\(fieldId, format, \{ from, to \}\)/);
  assert.match(reportCard, /scope !== currentScope\.current/);
  assert.match(reportCard, /requestApi !== currentApiRef\.current/);
  assert.match(reportCard, /const requestApi = api;/);
  assert.match(reportCard, /exportLock\.current = true/);
  assert.match(reportCard, /\['csv', 'pdf', 'xlsx'\]\.map/);
  assert.match(reportCard, /dataMode === 'live' &&/);
});
