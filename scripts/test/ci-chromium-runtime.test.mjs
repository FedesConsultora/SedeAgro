// Contract for the REAL Chromium preflight, independent of the browser
// package (which is installed only in browser jobs). Never replace the
// integration suites with a fake browser or a no-op installer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source=readFileSync(new URL('../ci-verify-playwright-chromium.mjs',import.meta.url),'utf8');
const workflow=readFileSync(new URL('../../.github/workflows/postgres-isolation.yml',import.meta.url),'utf8');

function job(name) {
  const start=workflow.indexOf('\n  '+name+':\n');
  assert.ok(start>=0);
  const rest=workflow.slice(start+1);
  const match=/^  [a-z][a-z0-9-]*:\s*$/gm;
  match.lastIndex=name.length+4;
  const next=match.exec(rest);
  return rest.slice(0,next?.index);
}

test('preflight must launch pinned Playwright Chromium and read real DOM',()=>{
  assert.match(source,/import \{ chromium \} from 'playwright'/);
  assert.match(source,/await chromium\.launch\(\{ headless: true \}\)/);
  assert.match(source,/await browser\.newPage\(\)/);
  assert.match(source,/await page\.goto\('data:text\/html,/);
  assert.match(source,/await page\.locator\('#ci-chromium-probe'\)\.textContent\(\)/);
  assert.match(source,/browser\.version\(\)/);
  assert.match(source,/process\.exitCode = 2/);
  assert.match(source,/await browser\.close\(\)/);
  assert.doesNotMatch(source,/mockBrowser|fakeBrowser|chromium\.connect/);
});

test('both complete browser suites run ONLY after successful real Chromium preflight',()=>{
  for(const name of ['browser-postgis','browser-offline']){
    const code=job(name);
    const install=code.indexOf('npx playwright install chromium\n');
    const preflight=code.indexOf('run: node scripts/ci-verify-playwright-chromium.mjs');
    assert.ok(install>=0 && preflight>install,name+' must install and launch Chromium');
    assert.doesNotMatch(code,/npx playwright install chromium --with-deps/);
    assert.doesNotMatch(code,/continue-on-error:\s*true/);
    const firstTest=code.indexOf(name==='browser-postgis'?
      'Run real Chromium cookie and session acceptance against PostgreSQL':
      'Real-browser IndexedDB migration, encryption and offline reload');
    assert.ok(firstTest>preflight,name+' must have substantive E2E after preflight');
  }
});
