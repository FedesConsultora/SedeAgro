import test from 'node:test';
import assert from 'node:assert/strict';
import { fieldReportRows } from '../src/modules/reports/fieldCsv.js';
import { buildFieldPdf, encodePdfWinAnsi } from '../src/modules/reports/fieldPdf.js';
import { buildFieldXlsx } from '../src/modules/reports/fieldXlsx.js';

const snapshot = {
  field: { id: 'd7b43d02-1e2b-4a7e-915a-cd98596d9e33',
    name: 'Lote Ñandú', area_hectares: '5.5', Farm: { name: 'Estancia Río' } },
  observations: [{ id: 'obs-1', observed_at: '2026-10-15T11:00:00Z',
    observation_type: 'weed', severity: 'high',
    notes: '=HYPERLINK("https://falso") & maleza Ñ' }],
  workOrders: [{ id: 'order-1', created_at: '2026-10-15T11:00:00Z',
    type: 'inspection', status: 'approved', priority: 'urgent',
    title: 'Revisar ácaros + reparación' }],
  period: { from: '2026-10-01', to: '2026-10-15' }
};
test('PDF is a valid self-contained multipage PDF 1.4 with WinAnsi Spanish glyphs', () => {
  const pdf = buildFieldPdf(snapshot);
  assert.equal(pdf.subarray(0, 8).toString('latin1'), '%PDF-1.4');
  assert.ok(pdf.length > 250);
  const body = pdf.toString('latin1');
  assert.match(body, /\/Type \/Catalog/);
  assert.match(body, /\/Type \/Page /);
  assert.match(body, /\/MediaBox \[0 0 595 842\]/);
  assert.match(body, /\/Encoding \/WinAnsiEncoding/);
  assert.match(body, /Observaciones: 1 \| Ordenes: 1/);
  assert.match(body, /HYPERLINK/);
  assert.match(body, /%%EOF/);
  assert.ok(pdf.includes(Buffer.from('Ñandú', 'latin1')));
  const startXref = /startxref\n(\d+)\n%%EOF/.exec(body);
  assert.ok(startXref, 'xref pointer must exist');
  assert.equal(body.slice(Number(startXref[1]), Number(startXref[1]) + 4), 'xref');
  assert.equal(encodePdfWinAnsi('áÑ€').toString('hex'), 'e1d180');
});

test('PDF transparently refuses non-WinAnsi text and page overflows', () => {
  assert.throws(() => buildFieldPdf({ ...snapshot,
    observations: [{ ...snapshot.observations[0], notes: 'Nota 🌾' }]
  }), /caracteres no admitidos/);
  assert.throws(() => buildFieldPdf({ ...snapshot,
    observations: Array.from({ length: 200 }, (_, i) => ({
      ...snapshot.observations[0], id: String(i), notes: 'm'.repeat(25000)
    }))
  }), /máximo de páginas/);
});

function unzipStoredEntries(bytes) {
  const entries = new Map();
  let cursor = 0;
  while (bytes.readUInt32LE(cursor) === 0x04034b50) {
    const compression = bytes.readUInt16LE(cursor + 8);
    assert.equal(compression, 0);
    const length = bytes.readUInt32LE(cursor + 18);
    const nameSize = bytes.readUInt16LE(cursor + 26);
    const extra = bytes.readUInt16LE(cursor + 28);
    const name = bytes.subarray(cursor + 30, cursor + 30 + nameSize).toString('utf8');
    const pos = cursor + 30 + nameSize + extra;
    entries.set(name, bytes.subarray(pos, pos + length).toString('utf8'));
    cursor = pos + length;
  }
  assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
  return entries;
}
test('XLSX is real OOXML ZIP, Unicode text only, never an Excel formula', () => {
  const workbook = buildFieldXlsx(snapshot);
  assert.equal(workbook.subarray(0, 4).toString('hex'), '504b0304');
  const files = unzipStoredEntries(workbook);
  assert.equal(files.size, 6);
  const xml = files.get('xl/worksheets/sheet1.xml');
  assert.match(xml, /<sheetData>/);
  assert.match(xml, /<autoFilter ref="A1:K4"/);
  assert.match(xml, /t="inlineStr"/);
  assert.match(xml, /Lote Ñandú/);
  assert.match(xml, /Estancia Río/);
  assert.match(xml, /=HYPERLINK\(&quot;https:\/\/falso&quot;\) &amp; maleza Ñ/);
  assert.doesNotMatch(xml, /<f[\s>]/);
  assert.match(files.get('xl/styles.xml'), /FF176348/);
  assert.match(files.get('[Content_Types].xml'), /spreadsheetml/);
  assert.match(files.get('xl/workbook.xml'), /Reporte por lote/);
});

test('XLSX strips only illegal XML controls but retains all international text', () => {
  const workbook = buildFieldXlsx({
    ...snapshot, observations: [{
      ...snapshot.observations[0], notes: '=1+1 🌾 Ñ\u0000\u0007 < &'
    }]
  });
  const xml = unzipStoredEntries(workbook).get('xl/worksheets/sheet1.xml');
  assert.ok(xml.includes('🌾 Ñ'));
  assert.ok(xml.includes('&lt; &amp;'));
  assert.ok(!xml.includes('\u0007'));
  assert.doesNotMatch(xml, /<f[\s>]/);
});

test('all document formats use exact same auditable row contract as CSV', () => {
  const rows = fieldReportRows(snapshot);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0].slice(0, 3), ['tipo_registro', 'id', 'fecha_utc']);
  assert.equal(rows[2][0], 'observacion');
  assert.equal(rows[3][0], 'orden');
  assert.equal(rows[2][8], snapshot.observations[0].notes);
});

test('verified order origin is exported in separate CSV/XLSX columns and legible PDF, never inferred from title', () => {
  const observationId = 'b6a4534c-6e82-4f4e-b0a2-35b6d4f9317d';
  const runId = 'ce2405b5-2d3e-48b0-905f-b294e90df64f';
  const linked = { ...snapshot, workOrders: [{
    ...snapshot.workOrders[0],
    observation_origin: { scouting_observation_id: observationId, scouting_run_id: runId }
  }] };
  const rows = fieldReportRows(linked);
  assert.equal(rows[0].length, 11);
  assert.deepEqual(rows[0].slice(-2), ['observacion_origen_id', 'recorrida_origen_id']);
  assert.deepEqual(rows[3].slice(-2), [observationId, runId]);
  assert.deepEqual(rows[2].slice(-2), ['', ''], 'observation rows have no inferred order origin');
  assert.deepEqual(fieldReportRows(snapshot)[3].slice(-2), ['', ''],
    'legacy order titles never invent an origin');
  const pdf = buildFieldPdf(linked).toString('latin1');
  assert.ok(pdf.includes('Origen verificado: observacion ' + observationId));
  assert.ok(pdf.includes('Recorrida de origen: ' + runId));
  assert.ok(!buildFieldPdf(snapshot).toString('latin1').includes('Origen verificado'));
  const xml = unzipStoredEntries(buildFieldXlsx(linked)).get('xl/worksheets/sheet1.xml');
  assert.ok(xml.includes(observationId) && xml.includes(runId));
  assert.match(xml, /<autoFilter ref="A1:K4"/);
  assert.doesNotMatch(xml, /<f[\\s>]/);
});
