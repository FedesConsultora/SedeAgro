import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFieldDocument, decodeFieldCsv, checkedFieldExportCounts } from '../src/services/reportDownload.js';
import { readFileSync } from 'node:fs';

const content = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const api = content('../src/services/api.js');
const reportCard = content('../src/components/FieldReportCard.jsx');

const FIELD = 'f7346146-34ef-42d7-b11b-95f92a06ba5b';
const OTHER_FIELD = 'e7346146-34ef-42d7-b11b-95f92a06ba5b';

function payload(format, bytes) {
  return {
    filename: `reporte-lote-${FIELD}.${format}`,
    mimeType: format === 'pdf' ? 'application/pdf' :
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    content_base64: Buffer.from(bytes).toString('base64'),
    size_bytes: bytes.length,
    counts: { observations: 1, workOrders: 2, executions: 3 }
  };
}
test('PDF and XLSX response decoder validates signatures and bytes', async () => {
  const pdf = decodeFieldDocument(payload('pdf', Buffer.from('%PDF-1.4 text')), 'pdf', FIELD);
  assert.equal(pdf.blob.type, 'application/pdf');
  assert.equal(pdf.blob.size, 13);
  assert.deepEqual(pdf.counts, { observations: 1, workOrders: 2, executions: 3 });
  const xlsx = decodeFieldDocument(payload('xlsx', Buffer.from([80,75,3,4,10,0])), 'xlsx', FIELD);
  assert.equal(xlsx.blob.size, 6);
  assert.match(xlsx.blob.type, /spreadsheetml/);
});
test('mismatched MIME, damaged files and too-large payloads block downloads', () => {
  assert.throws(() => decodeFieldDocument(payload('pdf', Buffer.from([80,75,3,4])), 'pdf', FIELD), /firma inválida/);
  assert.throws(() => decodeFieldDocument(payload('pdf', Buffer.from('%PDF-1.4')), 'xlsx', FIELD), /inválida/);
  assert.throws(() => decodeFieldDocument({ ...payload('pdf', Buffer.from('%PDF-1.4')),
    size_bytes: 100 }, 'pdf', FIELD), /tamaño inesperado/);
  assert.throws(() => decodeFieldDocument({ ...payload('pdf', Buffer.from('%PDF-1.4')),
    content_base64: '!NOT BASE64!' }, 'pdf', FIELD), /codificación válida/);
  assert.throws(() => decodeFieldDocument({ ...payload('pdf', Buffer.from('%PDF-1.4')),
    size_bytes: 4 * 1024 * 1024 }, 'pdf', FIELD), /inválida/);
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

test('execution counts are mandatory truthful download metadata, not silently treated as zero',()=>{
  const good = payload('pdf',Buffer.from('%PDF-1.4 text'));
  for(const counts of [
    {observations:1,workOrders:2},
    {...good.counts,executions:-1},
    {...good.counts,executions:201},
    {...good.counts,executions:2.5},
    {...good.counts,executions:'3'}
  ]){
    assert.throws(()=>decodeFieldDocument({...good,counts},'pdf'),/reporte inválida/);
  }
  assert.match(reportCard,/counts\.executions/);
  assert.match(reportCard,/ejecuciones declaradas/);
  assert.match(reportCard,/Las ejecuciones se filtran por su fecha de finalización/);
});

test('each export is tied to the requested field and truthful bounded counts', () => {
  const pdf = payload('pdf', Buffer.from('%PDF-1.4 text'));
  const xlsx = payload('xlsx', Buffer.from([80,75,3,4,10,0]));
  const csv = {
    filename: `reporte-lote-${FIELD}.csv`, mimeType: 'text/csv;charset=utf-8',
    csv: '\uFEFFtipo,fecha\r\n', counts: pdf.counts
  };
  assert.equal(decodeFieldCsv(csv, FIELD).blob.type, csv.mimeType);
  for (const format of ['pdf', 'xlsx']) {
    const document = format === 'pdf' ? pdf : xlsx;
    assert.throws(() => decodeFieldDocument(document, format, OTHER_FIELD), /lote solicitado/);
    assert.throws(() => decodeFieldDocument({ ...document,
      filename: `../reporte-lote-${FIELD}.${format}` }, format, FIELD), /lote solicitado/);
  }
  assert.throws(() => decodeFieldCsv(csv, OTHER_FIELD), /lote solicitado/);
  assert.throws(() => decodeFieldCsv({ ...csv, filename: 'reporte-lote.csv' }, FIELD), /lote solicitado/);
  for (const key of ['observations', 'workOrders', 'executions']) {
    for (const bad of [-1, 201, 1.5, '1', NaN, Infinity]) {
      const counts = { ...pdf.counts, [key]: bad };
      assert.throws(() => checkedFieldExportCounts(counts), /reporte inválida/);
      assert.throws(() => decodeFieldDocument({ ...pdf, counts }, 'pdf', FIELD), /reporte inválida/);
      assert.throws(() => decodeFieldCsv({ ...csv, counts }, FIELD), /reporte inválida/);
    }
  }
  assert.throws(() => checkedFieldExportCounts({ ...pdf.counts, privateField: true }), /reporte inválida/);
  assert.throws(() => decodeFieldCsv({ ...csv, csv: '\uFEFF' }, FIELD), /CSV inválido/);
  assert.throws(() => decodeFieldCsv({ ...csv, csv: '\uFEFF' + 'x'.repeat(1024 * 1024) }, FIELD), /CSV inválido/);
  assert.throws(() => decodeFieldCsv({ ...csv, csv: '\uFEFF' + 'ñ'.repeat(600_000) }, FIELD), /CSV inválido/);
});
