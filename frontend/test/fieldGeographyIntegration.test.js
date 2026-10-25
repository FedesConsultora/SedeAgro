import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (name) => readFileSync(new URL('../src/' + name, import.meta.url), 'utf8');
const page = read('pages/FarmsPage.jsx');
const panel = read('components/FieldGeographyPanel.jsx');
const form = read('components/FieldFormModal.jsx');

test('the farm list opens one readonly GIS detail per actual field ID', () => {
  assert.match(page, /fields\.map\(\(field\) =>/);
  assert.match(page, /setFocusedFieldId\(current => current === field\.id \? null : field\.id\)/);
  assert.match(page, /<FieldGeographyPanel\s+field=\{field\}\s+farm=\{farm\}/);
  assert.match(page, /aria-expanded=\{focusedFieldId === field\.id\}/);
});

test('the geometry view fetches tenant-authorized field detail, never trusts list polygon', () => {
  assert.match(panel, /api\.getField\(field\.id\)/);
  assert.match(panel, /parseFieldDetail\(response, field\.id, farm\.id\)/);
  assert.match(panel, /if \(!cancelled\) setResult/);
  assert.match(panel, /session\?\.tenant\?\.id/);
  assert.match(panel, /dataMode === 'mock'/);
  assert.match(panel, /record \? fieldGeography\(record\.boundary, farm\.centroid\)/);
});

test('the preview distinguishes georeferenced perimeter from farm location', () => {
  assert.match(panel, /fillRule="evenodd"/);
  assert.match(panel, /sin mapa base ni imagen satelital/);
  assert.match(panel, /OpenStreetMap abre la zona, pero no superpone el perímetro/);
  assert.match(panel, /Esta coordenada corresponde al establecimiento, no al lote/);
  assert.match(panel, /rel="noopener noreferrer"/);
});

test('field creation never substitutes mock farms into an authenticated tenant', () => {
  assert.doesNotMatch(form, /mockData\./);
  assert.match(form, /dataMode !== 'live'/);
  assert.match(form, /requestApi\.farms\(\)/);
  assert.match(form, /!Array\.isArray\(records\)/);
  assert.match(form, /scopeRef\.current === requestScope/);
  assert.match(form, /phase: 'error', farms: \[\]/);
  assert.match(form, /farmLoadError/);
  assert.match(form, /prepareFieldCreate\(form, farms, session\?\.tenant\?\.id, preselectedFarmId\)/);
  assert.match(form, /verifyCreatedField\(response, body, session\?\.tenant\?\.id\)/);
});

test('the displayed geometry resets when actor authorization or entitlements change', () => {
  assert.match(panel, /session\?\.membership\?\.roleCode \|\| ''/);
  assert.match(panel, /\(session\?\.entitlements \|\| \[\]\)\.join\(','\)/);
  assert.match(panel, /result\.scope === scope/);
  assert.match(panel, /record: null, error: ''/);
});
