import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const modal = source('../src/components/Modal.jsx');
const assets = source('../src/pages/AssetsPage.jsx');
const teams = source('../src/pages/TeamPage.jsx');
const farms = source('../src/pages/FarmsPage.jsx');
const campaigns = source('../src/pages/CampaignsPage.jsx');
const reports = source('../src/pages/ReportsPage.jsx');
const primitives = source('../src/components/WorkspacePrimitives.jsx');
const farmForm = source('../src/components/FarmFormModal.jsx');
const orderForm = source('../src/components/WorkOrderFormModal.jsx');
const browser = source('../../scripts/acceptance-browser-cookie.mjs');

test('dialog and drawer have named modal semantics, focus trapping, Escape and restoration', () => {
  assert.match(modal, /role="dialog" aria-modal="true" aria-labelledby=\{titleId\} tabIndex=\{-1\}/);
  assert.match(modal, /if \(event\.key === 'Escape'\)/);
  assert.match(modal, /event\.key === 'Tab'/);
  assert.match(modal, /previouslyFocused\?\.isConnected/);
  assert.match(modal, /dialogStack\[dialogStack\.length - 1\] !== id/);
});

test('asset creation and demo team invitation use the actual Modal isOpen API', () => {
  assert.equal((assets.match(/<Modal isOpen=/g) || []).length, 2);
  assert.equal((teams.match(/<Modal isOpen=/g) || []).length, 1);
  assert.doesNotMatch(assets + teams, /<Modal open=/);
  assert.match(teams, /dataMode === 'mock' && <button/);
});

test('farm and campaign expandable cards expose real button/aria-expanded semantics', () => {
  for (const page of [farms, campaigns]) {
    assert.match(page, /className="farm-card__toggle"/);
    assert.match(page, /aria-expanded=\{expanded\}/);
    assert.match(page, /aria-controls=\{regionId\}/);
    assert.doesNotMatch(page, /className="farm-card__header" onClick=/);
  }
  assert.match(campaigns, /aria-pressed=\{filter === s\}/);
});

test('shared workspace primitives preserve truthful empty, filtered, and loading states', () => {
  assert.match(primitives, /\['loading', 'empty', 'filtered'\]/);
  assert.match(primitives, /aria-busy=\{isLoading\}/);
  assert.match(campaigns, /status=\{filter === 'Todos' \? 'empty' : 'filtered'\}/);
  assert.match(reports, /status=\{fields\.length === 0 \? 'empty' : 'filtered'\}/);
  assert.match(reports, /onClick=\{\(\) => setSearch\(''\)\}/);
  assert.match(farms, /status="loading"/);
});

test('live farm and work order forms reject fabricated lookup choices', () => {
  assert.doesNotMatch(farmForm, /catch\s*\{\s*setProducers\(mockData/);
  assert.doesNotMatch(orderForm, /catch\s*\{\s*setFields\(mockData/);
  assert.match(farmForm, /!Array\.isArray\(rows\)/);
  assert.match(farmForm, /scopeRef\.current === requestScope/);
  assert.match(farmForm, /producerSnapshot\?\.scope === authority/);
  assert.match(farmForm, /prepareFarmCreate\(form, producers, session\?\.tenant\?\.id\)/);
  assert.match(farmForm, /visible\?\.phase === 'ready' && !blocked/);
  assert.match(orderForm, /if \(!Array\.isArray\(response\?\.data\)\)/);
  assert.match(orderForm, /fields\.some\(field => field\.id === form\.field_id\)/);
  assert.match(farmForm, /producersError && <ResourceLoadNotice/);
  assert.match(farmForm, /disabled=\{!editable\}/);
});

test('actual Chromium flow proves focus cycle and blocked live lookups', () => {
  assert.ok(browser.includes('for (let cycle = 1; cycle <= focusCycles; cycle += 1)'));
  assert.ok(browser.includes('getFocusStressCycles()'));
  assert.match(browser, /'farm-pending-last'/);
  assert.match(browser, /'farm-after-lookup-new-last'/);
  assert.match(browser, /'farm-after-lookup-restored-opener'/);
  assert.match(browser, /PASS: Chromium farm modal focus loop /);
  assert.match(browser, /'farm-ready-root-' \+ cycle/);
  assert.match(browser, /'farm-ready-last-' \+ cycle/);
  assert.match(browser, /'farm-ready-first-' \+ cycle/);
  assert.match(browser, /'farm-ready-return-' \+ cycle/);
  assert.match(browser, /'farm-error-last-enabled'/);
  assert.match(browser, /'order-error-last-enabled'/);
  assert.match(browser, /await page1.keyboard.press\('Escape'\)/);
  assert.match(browser, /PASS: live farm form never falls back to mock producer list/);
  assert.match(browser, /PASS: live order form blocks creation when field lookup fails/);
});
