import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { workOrderCreateFingerprint } from '../src/modules/workOrders/createIdempotency.js';

const fieldId='b5f05b5f-1132-4342-b385-c004443f2cd9';
const campaignId='de16b90c-4b72-4490-9f5f-b20fe3c804be';
const observationId='b6a4534c-6e82-4f4e-b0a2-35b6d4f9317d';
const otherObservation='9d941d8a-9a66-4c6d-8469-54c37596e3a9';
const input={field_id:fieldId,campaign_field_id:campaignId,
  type:'inspection',priority:'normal',title:'Revisar malezas',
  instructions:'Autorización profesional antes de ejecutar',
  due_at:new Date('2026-11-03T12:00:00.000Z')};

test('old client-request UUIDs keep their exact SHA-256 without an origin', () => {
  // Freeze the pre-origin canonical JSON contract: old receipts in PostgreSQL
  // must remain replayable after the migration, including omitted properties.
  const before={
    campaign_field_id:campaignId,field_id:fieldId,type:'inspection',
    priority:'normal',due_at:'2026-11-03T12:00:00.000Z',
    title:'Revisar malezas',
    instructions:'Autorización profesional antes de ejecutar',
    status:'draft'
  };
  const oldHash=createHash('sha256').update(JSON.stringify(before)).digest('hex');
  assert.equal(workOrderCreateFingerprint(input),oldHash);
  assert.equal(workOrderCreateFingerprint({...input,origin_observation_id:undefined}),oldHash);
  assert.equal(workOrderCreateFingerprint({...input,origin_observation_id:null}),oldHash);
});

test('a different valid observation changes the actor-scoped idempotency hash', () => {
  const linked={...input,origin_observation_id:observationId};
  const changed={...input,origin_observation_id:otherObservation};
  assert.notEqual(workOrderCreateFingerprint(linked),workOrderCreateFingerprint(input));
  assert.notEqual(workOrderCreateFingerprint(linked),workOrderCreateFingerprint(changed));
  assert.equal(workOrderCreateFingerprint(linked),workOrderCreateFingerprint({...linked}));
});

test('the persisted link cannot bypass tenant, lot or campaign FKs and never stores notes', () => {
  const source=readFileSync(new URL('../db/migrations/202611030001_work_order_observation_origins.js',
    import.meta.url),'utf8');
  assert.match(source,/FORCE ROW LEVEL SECURITY/);
  assert.match(source,/PRIMARY KEY \(tenant_id, work_order_id\)/);
  assert.match(source,/FOREIGN KEY \(tenant_id, work_order_id, field_id, campaign_field_id\)/);
  assert.match(source,/FOREIGN KEY \(tenant_id, scouting_observation_id, scouting_run_id, field_id\)/);
  assert.match(source,/FOREIGN KEY \(tenant_id, scouting_run_id, campaign_field_id\)/);
  assert.doesNotMatch(source,/point geometry|content_base64|notes text|storage_key/);
  const backend=readFileSync(new URL('../src/modules/workOrders/router.js',import.meta.url),'utf8');
  assert.match(backend,/await persistObservationOrigin\(req, order.id, origin\)/);
  assert.match(backend,/await readObservationOrigin\(req, order.id\)/);
});
