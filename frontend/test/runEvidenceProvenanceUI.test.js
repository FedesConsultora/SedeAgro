import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL('../src/' + path, import.meta.url), 'utf8');
const route = readFileSync(new URL('../../backend/src/modules/scouting/router.js', import.meta.url), 'utf8');
const page = read('pages/ScoutingPage.jsx');
const panel = read('components/RunEvidenceProvenance.jsx');
const service = read('services/runEvidenceProvenance.js');
const api = read('services/api.js');

test('run detail mounts provenance only after successful live authorized detail', () => {
  assert.match(page, /dataMode === 'live' && !loading && !error && details && \(\s*<RunEvidenceProvenance runId=\{details\.id\}/);
  assert.match(page, /parseScoutingRunDetail\(response, run\.id\)/);
  assert.match(page, /onOpenSync=\{onOpenSync\}/);
  assert.match(panel, /canNavigateView\('scouting', access\)/);
  assert.match(panel, /sessionScope\(session\)/);
});

test('server route validates assignment and capability before returning metadata without selecting bytes', () => {
  assert.match(route, /get\('\/runs\/:id\/evidence-status', requireCapability\('scouting.read'\)/);
  assert.match(route, /const run = await findRun\(req, req.params.id\)/);
  assert.match(route, /EvidenceBlob\.findAll\(\{/);
  assert.match(route, /attributes: \['evidence_id'\]/);
  assert.match(route, /evidence_id: \{ \[Op.in\]: ids \}/);
  assert.match(route, /limit: RUN_EVIDENCE_LIMIT \+ 1/);
  assert.match(route, /Cache-Control', 'private, no-store'/);
  assert.doesNotMatch(route.slice(route.indexOf("get('/runs/:id/evidence-status'"),
    route.indexOf("post('/runs/:runId/observations'")), /getPrivateEvidence\(|content_base64|storage_key|attributes: \['content'\]/);
});

test('only read-only scoped sources are touched; local data never cleared or resent', () => {
  assert.match(api, /getRunEvidenceStatus: \(id\) => request\(`\/scouting\/runs\/\$\{id\}\/evidence-status`\)/);
  assert.match(panel, /api\.getRunEvidenceStatus\(runId\)/);
  assert.match(panel, /offlineQueue\.list\(session\)/);
  assert.match(panel, /buildRunEvidenceProvenance\(response, rows, session, runId\)/);
  assert.doesNotMatch(panel, /getEvidenceContent|submitOfflineEvidence|offlineQueue\.(discard|flush|recoverPhoto|confirmApplied|allowRetry)/);
  assert.match(panel, /contextRef\.current === key/);
  assert.match(panel, /requestSeq\.current === sequence/);
  assert.match(panel, /requestSeq\.current \+= 1/);
});

test('offline, malformed or revocation results cannot present previous confirmed bytes', () => {
  assert.match(panel, /phase: 'offline', result: null/);
  assert.match(panel, /phase: 'error', result: null/);
  assert.match(panel, /window\.addEventListener\('offline', offline\)/);
  assert.match(panel, /window\.addEventListener\('online', update\)/);
  assert.match(panel, /window\.addEventListener\(QUEUE_EVENT, update\)/);
  assert.match(panel, /visibilitychange/);
  assert.match(panel, /No se puede afirmar que no existan archivos/);
  assert.match(panel, /result\.hasMore/);
  assert.match(panel, /ningún resultado ausente se interpreta como un fallo/);
});

test('privacy and epistemic caveats: metadata presence never claims content integrity or local deletion', () => {
  assert.match(panel, /Presencia de bytes no implica validación criptográfica/);
  assert.match(panel, /no elimina capturas ni sustituye la confirmación de subida/);
  assert.match(service, /asset\?\.id \|\| null/);
  assert.match(service, /item\.uploadedBy === session\.user\.id/);
  assert.match(service, /item\.clientUploadId === photo\.client_upload_id/);
  assert.match(service, /validateOfflinePhoto\(row\.evidence\)/);
  assert.doesNotMatch(panel, /content_base64|\.notes|\.coordinates|original_name|\.uploadedBy|<img /);
  assert.doesNotMatch(service, /JSON\.stringify\(photo\)|\.content_base64/);
});
