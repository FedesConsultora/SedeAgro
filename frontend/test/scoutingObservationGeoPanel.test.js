import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('../src/pages/ScoutingPage.jsx', import.meta.url), 'utf8');
const component = readFileSync(new URL('../src/components/ScoutingObservationGeoPanel.jsx', import.meta.url), 'utf8');
const runDetail = page.split('export function ScoutingPage')[0];

test('GIS view is only shown after authorized live run detail loads', () => {
  assert.match(runDetail, /dataMode === 'live' && !loading && !error && details && \(/);
  assert.match(runDetail, /<ScoutingObservationGeoPanel/);
  assert.match(runDetail, /observations=\{observations\}/);
  assert.match(runDetail, /boundary=\{details\.CampaignField\?\.Field\?\.boundary\}/);
  assert.match(runDetail, /parseScoutingRunDetail\(response, run\.id, session\?\.tenant\?\.id\)/);
  assert.doesNotMatch(runDetail, /api\.getField\(/);
});

test('observation geography only plots server points and explicit field boundary', () => {
  assert.match(component, /scoutingObservationGeography\(observations, boundary\)/);
  assert.match(component, /mode === 'field' && <path d=\{field\.path\}/);
  assert.match(component, /mode === 'gps'/);
  assert.match(component, /totals\.outside/);
  assert.match(component, /totals\.missing \+ totals\.invalid/);
  assert.match(component, /role="status"/);
});

test('GPS coordinates are sent externally only after clicking a safe link', () => {
  assert.match(component, /href=\{observationMapUrl\(row\.point\)\}/);
  assert.match(component, /target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(component, /<iframe|fetch\(|<img/);
  assert.match(component, /aria-pressed=\{filter === option\.key\}/);
  assert.match(component, /aria-pressed=\{row\.id === selectedId\}/);
});

test('no backend, capture, offline mutation or fake persistence in this view', () => {
  assert.doesNotMatch(component, /offlineQueue|queueObservation|navigator\.geolocation|api\./);
  assert.doesNotMatch(component, /setInterval|watchPosition|localStorage/);
  assert.match(component, /no borradores pendientes/);
});
