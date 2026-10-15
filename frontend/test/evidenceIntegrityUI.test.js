import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL('../src/' + path, import.meta.url), 'utf8');
const route = readFileSync(new URL('../../backend/src/modules/scouting/router.js', import.meta.url), 'utf8');
const storage = readFileSync(new URL('../../backend/src/modules/scouting/evidenceStorage.js', import.meta.url), 'utf8');
const panel = read('components/RunEvidenceProvenance.jsx');
const checks = read('components/EvidenceIntegrityChecks.jsx');
const api = read('services/api.js');

test('only an authorized observation evidence ID can be checked in server and browser', () => {
  assert.match(route, /get\('\/evidence\/:id\/integrity', requireCapability\('scouting.read'\)/);
  const section = route.split("get('/evidence/:id/integrity'")[1].split("get('/evidence/:id/content'")[0];
  assert.match(section, /tenant_id: req.tenantId/);
  assert.match(section, /findRun\(req, observation.scouting_run_id\)/);
  assert.match(section, /getPrivateEvidenceByteLength/);
  assert.match(section, /shouldReadEvidenceBytes/);
  assert.match(section, /getBoundedPrivateEvidence/);
  assert.match(section, /Cache-Control', 'private, no-store'/);
  assert.match(section, /res.json\(\{ data: \{ id: evidence.id, status \} \}\)/);
  assert.doesNotMatch(section, /getPrivateEvidence\(|content_base64|original_name|res.json\(\{ data: evidence/);
  assert.match(api, /getEvidenceIntegrity: \(id\) => request\(`\/scouting\/evidence\/\$\{id\}\/integrity`\)/);
});

test('server SQL limits one integrity byte read without transmitting bytes in size probe', () => {
  assert.match(storage, /attributes: \[\[fn\('octet_length', col\('content'\)\), 'byte_length'\]\]/);
  const selection = storage.split('export async function getBoundedPrivateEvidence')[1];
  assert.match(selection, /\[Op.lte\]: MAX_EVIDENCE_BYTES/);
  assert.match(selection, /tenant_id: tenantId/);
  assert.match(selection, /evidence_id: evidenceId/);
});

test('one-by-one manual-only UI, no bulk scanning, file payload or destructive draft actions', () => {
  assert.match(panel, /<EvidenceIntegrityChecks key=\{key\}/);
  assert.match(panel, /items=\{result.items.slice\(0, 10\)\}/);
  assert.match(checks, /onClick=\{\(\) => void check\(item.id\)\}/);
  assert.match(checks, /items.some\(item => item.id === id\)/);
  assert.match(checks, /api.getEvidenceIntegrity\(id\)/);
  assert.match(checks, /parseEvidenceIntegrity\(response, id\)/);
  assert.match(checks, /sessionScope\(session\)/);
  assert.match(checks, /scopeKey.startsWith\(ownScope \+ ':'\)/);
  assert.match(checks, /serial.current === requestId/);
  assert.match(checks, /window.addEventListener\('offline', onOffline\)/);
  assert.match(checks, /serial.current \+= 1/);
  assert.match(checks, /const check = async \(id\) =>/);
  assert.match(checks, /window.addEventListener\('offline', onOffline\)/);
  assert.doesNotMatch(checks, /offlineQueue|submitOfflineEvidence|discard|fetch\(|getEvidenceContent/);
  assert.doesNotMatch(checks, /content_base64|original_name|\.notes|\.coordinates|data:image|<img/);
});

test('error/offline and unverified results never masquerade as successful SHA-256', () => {
  assert.match(checks, /phase: 'error'/);
  assert.match(checks, /No se puede asegurar su integridad/);
  assert.match(checks, /state.status === 'verified'/);
  assert.match(panel, /Presencia de bytes no implica validación criptográfica/);
});
