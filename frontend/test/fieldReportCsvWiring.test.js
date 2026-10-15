import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const file = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const api = file('../src/services/api.js');
const card = file('../src/components/FieldReportCard.jsx');
const reports = file('../src/pages/ReportsPage.jsx');

test('CSV downloads only from actual cookie-authenticated reports client, never mock data', () => {
  assert.match(api, /exportFieldCsv: \(fieldId, \{ from = '', to = '' \} = \{\}\)/);
  assert.match(api, /request\(\`\/reports\/field\/\$\{encodeURIComponent\(fieldId\)\}\/export\.csv/);
  assert.match(card, /dataMode !== 'live'/);
  assert.match(card, /dataMode === 'live' &&/);
  assert.match(card, /scope !== currentScope\.current/);
  assert.match(card, /Blob\(\[response\.data\.csv\]/);
  assert.match(card, /URL\.revokeObjectURL\(url\)/);
  assert.match(reports, /FieldReportCard/);
});

test('period and failure states are visible and client does not fabricate success', () => {
  assert.match(card, /type="date" value=\{from\}/);
  assert.match(card, /type="date" value=\{to\}/);
  assert.match(card, /from > to/);
  assert.match(card, /aria-busy=\{exporting\}/);
  assert.match(card, /exportError && <p role="alert"/);
  assert.match(card, /exportStatus && <p role="status"/);
  assert.doesNotMatch(card, /mockData.*csv|localStorage\.setItem.*csv/);
});
