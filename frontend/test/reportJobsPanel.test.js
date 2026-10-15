import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { decodeAsyncReportFile } from '../src/services/reportArtifactClient.js';

function file(format, bytes) {
  return {
    filename: 'reporte-lote-id.' + format,
    mimeType: format === 'pdf' ? 'application/pdf' :
      format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' :
      'text/csv;charset=utf-8',
    content_base64: bytes.toString('base64'),
    size_bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex')
  };
}
test('valid SHA-256-verified private documents can be downloaded', async () => {
  for (const [format, bytes] of [
    ['pdf', Buffer.from('%PDF-1.4 private')],
    ['xlsx', Buffer.from([80,75,3,4,1,0,0])],
    ['csv', Buffer.from([239,187,191,97,44,98,10])]
  ]) {
    const result = await decodeAsyncReportFile(file(format, bytes));
    assert.equal(result.filename, 'reporte-lote-id.' + format);
    assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()), bytes);
  }
});

test('mismatched digest, size, MIME and binary signature are rejected', async () => {
  const data = file('pdf', Buffer.from('%PDF-1.4'));
  for (const invalid of [
    { ...data, sha256: '0'.repeat(64) },
    { ...data, mimeType: 'text/html' },
    { ...data, size_bytes: data.size_bytes + 1 },
    { ...data, content_base64: '##' },
    { ...data, filename: 'dangerous.txt' },
    { ...data, size_bytes: 4 * 1024 * 1024 }
  ]) {
    await assert.rejects(decodeAsyncReportFile(invalid));
  }
});

test('report panel never displays data from demo or previous auth epoch', () => {
  const panel = readFileSync(new URL('../src/components/ReportJobsPanel.jsx', import.meta.url), 'utf8');
  const screen = readFileSync(new URL('../src/pages/ReportsPage.jsx', import.meta.url), 'utf8');
  assert.match(screen, /ReportJobsPanel fields=\{fields\}/);
  assert.match(panel, /dataMode !== 'live' \|\| !scope/);
  assert.match(panel, /current\.current\.api === origin\.api/);
  assert.match(panel, /decodeAsyncReportFile\(response\.data\)/);
  assert.match(panel, /workerOnline/);
  assert.match(panel, /\['queued', 'running'\]\.includes/);
});
