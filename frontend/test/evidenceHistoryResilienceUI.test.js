import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL('../src/'+path,import.meta.url),'utf8');
const panel=read('components/RunEvidenceProvenance.jsx');
const api=read('services/api.js');
const checks=read('components/EvidenceIntegrityChecks.jsx');

test('transport supports AbortSignal and no toast for canceled page reads', () => {
  assert.match(api,/getRunEvidencePage: \(id, cursor = null, \{ signal \} = \{\}\)/);
  assert.match(api,/\{ signal, silent: true \}/);
  assert.match(api,/\.\.\.requestOptions/);
  assert.match(panel,/const controller = new AbortController\(\)/);
  assert.match(panel,/getRunEvidencePage\(runId, cursor, \{ signal: controller\.signal \}\)/);
  assert.match(panel,/controller\.abort\(\)/);
  assert.match(panel,/!controller\.signal\.aborted && requestSeq\.current === sequence/);
});

test('offline cancels HTTP, clears confirmed rows, and reconnected flow starts with fresh first page', () => {
  assert.match(panel,/const offline = \(\) => \{\s*controller\.abort\(\)/);
  assert.match(panel,/setSnapshot\(\{ key: pageKey, phase: 'offline', result: null/);
  assert.match(panel,/const online = \(\) => \{[^]*?setNavigation\(\{ key, cursors: \[\] \}\)/);
  assert.match(panel,/window\.addEventListener\('online', online\)/);
  assert.match(panel,/window\.removeEventListener\('online', online\)/);
  assert.match(panel,/window\.removeEventListener\('offline', offline\)/);
  assert.match(panel,/requestSeq\.current \+= 1/);
  assert.match(panel,/contextRef\.current === key/);
});

test('invalid cursor and network failures have recovery actions, never false success', () => {
  assert.match(panel,/isInvalidEvidenceCursor\(error\)/);
  assert.match(panel,/phase: cursor && isInvalidEvidenceCursor\(error\) \? 'invalid-cursor' : 'error'/);
  assert.match(panel,/Reintentar esta página/);
  assert.match(panel,/Reiniciar historial/);
  assert.match(panel,/const refreshFirst = \(\) => \{/);
  assert.match(panel,/setNavigation\(\{ key, cursors: \[\] \}\)/);
  assert.match(panel,/advanceEvidencePage\(pageCursors, result\.nextCursor\)/);
  assert.match(panel,/previousEvidencePage\(pageCursors\)/);
  assert.match(panel,/No se puede afirmar que no existan archivos/);
});

test('on-page SHA-256 remains explicit and no evidence/offline mutations are added', () => {
  assert.match(panel,/<EvidenceIntegrityChecks key=\{pageKey\}/);
  assert.match(panel,/items=\{result\.items\.slice\(0, 10\)\}/);
  assert.match(checks,/onClick=\{\(\) => void check\(item\.id\)\}/);
  assert.doesNotMatch(panel,/offlineQueue\.(discard|flush|confirmApplied|recoverPhoto|clear)|getEvidenceContent/);
  assert.doesNotMatch(panel,/content_base64|original_name|\.coordinates|storage_key|<img/);
});
