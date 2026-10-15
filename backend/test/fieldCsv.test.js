import test from 'node:test';
import assert from 'node:assert/strict';
import {
  csvSafeCell, fieldCsvPeriod, buildFieldCsv,
  FIELD_CSV_MAX_ROWS_PER_KIND
} from '../src/modules/reports/fieldCsv.js';

test('period boundaries are UTC full calendar days, not local timezone guesses', () => {
  const p = fieldCsvPeriod('2026-10-01', '2026-10-15');
  assert.equal(p.start.toISOString(), '2026-10-01T00:00:00.000Z');
  assert.equal(p.exclusiveEnd.toISOString(), '2026-10-16T00:00:00.000Z');
  assert.deepEqual(fieldCsvPeriod(), {
    from: null, to: null, start: null, exclusiveEnd: null
  });
  assert.throws(() => fieldCsvPeriod('2026-02-30'), /inexistente/);
  assert.throws(() => fieldCsvPeriod('2026-10-16', '2026-10-15'), /fecha final/);
  assert.throws(() => fieldCsvPeriod('2026-1-01'), /Fecha inválida/);
});

test('all untrusted cells are always quoted and spreadsheet formula markers disarmed', () => {
  for (const input of ['=HYPERLINK("https://phish")', '+SUM(1,1)', '-1+1',
    '@SUM(A1)', '  =cmd', '\t@formula', '\n-1']) {
    const output = csvSafeCell(input);
    assert.match(output, /^"'?/);
    assert.equal(output[1], "'", input);
    assert.ok(output.startsWith("\"'"));
  }
  assert.equal(csvSafeCell('a,"b"'), '"a,""b"""');
  assert.equal(csvSafeCell('Campo\0A'), '"CampoA"');
  assert.equal(csvSafeCell(null), '""');
});

test('field CSV includes explicit header, lot snapshot, observations, orders with UTF-8 BOM', () => {
  const text = buildFieldCsv({
    field: { id: 'field-a', name: 'Lote A', Farm: { name: 'Campo Ñ' }, area_hectares: '12.50' },
    observations: [{ id: 'obs-1', observed_at: '2026-10-15T10:00:00Z',
      observation_type: 'weed', severity: 'high', notes: '=1+1' }],
    workOrders: [{ id: 'order-1', created_at: '2026-10-12T12:00:00Z',
      type: 'inspection', status: 'approved', priority: 'normal', title: 'Cosecha' }]
  });
  assert.ok(text.startsWith('\uFEFF"tipo_registro"'));
  assert.ok(text.includes('"Campo Ñ"'));
  assert.ok(text.includes('"hectareas"'));
  assert.ok(text.includes('"\'=1+1"'));
  assert.ok(text.includes('"2026-10-12T12:00:00.000Z"'));
  assert.equal(text.split('\r\n').length, 5); // 3 rows + header + terminal blank
});

test('CSV prevents silent truncation at per-kind bound and at total bytes', () => {
  assert.throws(() => buildFieldCsv({
    field: { id: 'f', name: 'F' },
    observations: Array.from({ length: FIELD_CSV_MAX_ROWS_PER_KIND + 1 }, () => ({})),
    workOrders: []
  }), /demasiadas filas/);
  assert.throws(() => buildFieldCsv({
    field: { id: 'f', name: 'F' },
    observations: Array.from({ length: 150 }, (_, i) => ({
      id: String(i), notes: 'X'.repeat(8000), observation_type: 'general', severity: 'low'
    })), workOrders: []
  }), /supera 1 MiB/);
});
