import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeEvidencePageCursor, decodeEvidencePageCursor, parseEvidencePageQuery,
  DEFAULT_EVIDENCE_PAGE_LIMIT, MAX_EVIDENCE_PAGE_LIMIT
} from '../src/modules/scouting/evidencePagination.js';

const tenantId = '1471918c-90f4-4e30-b4c1-c77cd332751e';
const runId = 'd2354576-df28-45bd-ae30-811f30543fea';
const otherRun = 'fb8cb58a-51a3-429e-8993-1f39eac279b6';
const otherTenant = '5b2343f4-1bc8-4acd-becd-78b9dc883dfd';
const id = '933550b8-2c4f-48a2-9fa8-3cdfa8149b8a';
const secret = 'this-is-a-test-only-cursor-signing-secret';
const scope = { tenantId, runId, secret };
const row = { id, created_at: new Date('2026-10-15T12:31:44.421Z') };

test('default remains 100 for pre-existing 0S.12 clients; explicit bounded page sizes are supported', () => {
  assert.equal(DEFAULT_EVIDENCE_PAGE_LIMIT, 100);
  assert.equal(MAX_EVIDENCE_PAGE_LIMIT, 100);
  assert.deepEqual(parseEvidencePageQuery({}, scope), { limit: 100, after: null });
  for (const limit of [1, 10, 20, 99, 100]) {
    assert.deepEqual(parseEvidencePageQuery({ limit: String(limit) }, scope), { limit, after: null });
  }
  for (const limit of ['0', '101', '-1', '1.1', '+1', '010', '1e1', 10, ['10'], {}, '', null]) {
    assert.throws(() => parseEvidencePageQuery({ limit }, scope), /Límite|Parámetros/);
  }
  assert.throws(() => parseEvidencePageQuery({ limit: '10', offset: '5' }, scope), /Parámetros/);
});

test('signed keyset encodes stable timestamp and UUID, scoped to tenant run and page size', () => {
  const cursor = encodeEvidencePageCursor(row, { ...scope, limit: 10 });
  assert.match(cursor, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(decodeEvidencePageCursor(cursor, { ...scope, limit: 10 }), {
    date: row.created_at, id
  });
  assert.deepEqual(parseEvidencePageQuery({ limit: '10', cursor }, scope), {
    limit: 10, after: { date: row.created_at, id }
  });
  assert.throws(() => decodeEvidencePageCursor(cursor, {
    ...scope, tenantId: otherTenant, limit: 10
  }), /Cursor/);
  assert.throws(() => decodeEvidencePageCursor(cursor, { ...scope, runId: otherRun, limit: 10 }), /Cursor/);
  assert.throws(() => decodeEvidencePageCursor(cursor, { ...scope, limit: 20 }), /Cursor/);
  assert.throws(() => decodeEvidencePageCursor(cursor, {
    ...scope, secret: 'another-test-only-hmac-signing-secret', limit: 10
  }), /Cursor/);
});

test('tampering or invalid cursor shapes fail closed before storage access', () => {
  const cursor = encodeEvidencePageCursor(row, { ...scope, limit: 10 });
  const [data, signature] = cursor.split('.');
  const illegal = [
    '', 'broken', '.', cursor + 'A', cursor + '.extra',
    'a'.repeat(641), `${data.slice(0,-1)}A.${signature}`,
    `${data}.${signature.slice(0,-1)}A`,
    `${data}.not_a_real_hmac`,
    null, ['evil']
  ];
  for (const value of illegal) assert.throws(() => parseEvidencePageQuery({
    limit: '10', cursor: value
  }, scope), /Cursor/);
});

test('cannot issue cursors for malformed identities, dates, bounds or weak signing secret', () => {
  for (const invalid of [
    { id: 'bad', created_at: row.created_at },
    { id, created_at: 'not a date' },
    { id, created_at: null }
  ]) assert.throws(() => encodeEvidencePageCursor(invalid, { ...scope, limit: 10 }));
  assert.throws(() => encodeEvidencePageCursor(row, { ...scope, limit: 101 }));
  assert.throws(() => encodeEvidencePageCursor(row, { ...scope, limit: 10, secret: 'short' }));
});
