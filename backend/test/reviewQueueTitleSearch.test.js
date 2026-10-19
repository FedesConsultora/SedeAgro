import test from 'node:test';
import assert from 'node:assert/strict';
import { REVIEW_TITLE_QUERY_MAX_CODEPOINTS, normalizeReviewTitleQuery,
  reviewQueueTitleWhere } from '../src/modules/workOrders/reviewQueueTitleSearch.js';

test('search phrase canonicalizes whitespace + Unicode and bounds length', () => {
  assert.equal(REVIEW_TITLE_QUERY_MAX_CODEPOINTS, 64);
  assert.equal(normalizeReviewTitleQuery(''), '');
  assert.equal(normalizeReviewTitleQuery('   '), '');
  assert.equal(normalizeReviewTitleQuery('  Orden  de\nCAMPO  '), 'Orden de CAMPO');
  assert.equal(normalizeReviewTitleQuery('  Cafe\u0301 '), 'Café');
  assert.equal(normalizeReviewTitleQuery('a'.repeat(64)), 'a'.repeat(64));
  for (const invalid of [null,undefined,['title'],'a','a'.repeat(65),
    'a\u0000b','a\u200bb','x\u007fy']) {
    assert.throws(() => normalizeReviewTitleQuery(invalid), /inválido/);
  }
});

test('title search is case-insensitive literal substring, not a LIKE wildcard', () => {
  const query = '%_ literal';
  assert.equal(normalizeReviewTitleQuery(query), query);
  const condition = reviewQueueTitleWhere(query);
  assert.ok(condition, 'Sequelize condition must be supplied as a value');
  assert.throws(()=>reviewQueueTitleWhere(''),/inválido/);
  assert.throws(()=>reviewQueueTitleWhere('  title'),/inválido/);
  assert.throws(()=>reviewQueueTitleWhere('a'),/inválido/);
});
