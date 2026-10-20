import test from 'node:test';
import assert from 'node:assert/strict';
import { getFocusStressCycles } from '../support/focus-stress-config.mjs';

test('default real Chromium focus acceptance never runs fewer than four cycles', () => {
  assert.equal(getFocusStressCycles({}), 4);
  assert.equal(getFocusStressCycles({ SEDEAGRO_FOCUS_STRESS_CYCLES: '' }), 4);
});

test('only explicit disposable GitHub CI can raise stress up to sixteen cycles', () => {
  for (const n of [4, 8, 12, 16]) {
    assert.equal(getFocusStressCycles({
      CI: 'true', GITHUB_ACTIONS: 'true', SEDEAGRO_FOCUS_STRESS_CYCLES: String(n)
    }), n);
  }
});

test('never accept invalid counts, disabling controls, or local forced stress', () => {
  for (const bad of ['0', '1', '2', '3', '17', '999', '-1', '4.0', ' 4', '4 ', '08', 'NaN']) {
    assert.throws(() => getFocusStressCycles({
      CI: 'true', GITHUB_ACTIONS: 'true', SEDEAGRO_FOCUS_STRESS_CYCLES: bad
    }), /BLOCKED/);
  }
  assert.throws(() => getFocusStressCycles({
    CI: 'false', GITHUB_ACTIONS: 'true', SEDEAGRO_FOCUS_STRESS_CYCLES: '12'
  }), /BLOCKED/);
  assert.throws(() => getFocusStressCycles({
    CI: 'true', GITHUB_ACTIONS: 'false', SEDEAGRO_FOCUS_STRESS_CYCLES: '12'
  }), /BLOCKED/);
});
