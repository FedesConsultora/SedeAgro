import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceEvidencePage, previousEvidencePage, isInvalidEvidenceCursor
} from '../src/services/evidencePageNavigation.js';

test('stable cursor stack supports both directions without mutating prior pages', () => {
  const first=[];
  const second=advanceEvidencePage(first,'one');
  const third=advanceEvidencePage(second,'two');
  assert.deepEqual(first,[]);
  assert.deepEqual(second,['one']);
  assert.deepEqual(third,['one','two']);
  assert.deepEqual(previousEvidencePage(third),['one']);
  assert.deepEqual(previousEvidencePage(second),[]);
  assert.deepEqual(previousEvidencePage(first),[]);
});

test('repeated, empty, malformed or cyclic cursors refuse navigation', () => {
  for (const [stack, next] of [
    [['one'],'one'],[['one','two'],'one'],[['one','two'],'two'],
    [['one'],''],[['one'],null],[[null],'new'],[{},'new'],
    [[],false]
  ]) assert.throws(() => advanceEvidencePage(stack,next), /cursor nuevo válido/);
});

test('only a validated 400 cursor error may offer targeted restart', () => {
  assert.equal(isInvalidEvidenceCursor({status:400,code:'EVIDENCE_CURSOR_INVALID'}),true);
  for(const issue of [
    null,{status:401,code:'EVIDENCE_CURSOR_INVALID'},
    {status:403,code:'EVIDENCE_CURSOR_INVALID'},
    {status:404,code:'EVIDENCE_CURSOR_INVALID'},
    {status:400,code:'EVIDENCE_LIMIT_INVALID'},
    {status:500,code:'EVIDENCE_CURSOR_INVALID'},
    {status:0,code:'NETWORK_ERROR'}
  ]) assert.equal(isInvalidEvidenceCursor(issue),false);
});
