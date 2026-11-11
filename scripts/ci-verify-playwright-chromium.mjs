// Actual Playwright Chromium runtime admission, not a mock or download-only check.
// Run AFTER installing the pinned Playwright package and its browser bundle.
// A CI image missing shared libraries must fail before any acceptance case.
import { chromium } from 'playwright';

let browser;
try {
  if (process.argv.length !== 2) throw new Error('unexpected arguments');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('data:text/html,<main id="ci-chromium-probe">SedeAgro-CI-Chromium</main>');
  const value = await page.locator('#ci-chromium-probe').textContent();
  if (value !== 'SedeAgro-CI-Chromium' ||
      !/^\d+\.\d+\.\d+\.\d+$/.test(browser.version())) {
    throw new Error('Chromium failed DOM and version probe');
  }
  console.log('PASS CI Chromium: pinned browser launched and executed real DOM probe');
} catch {
  // Do not silently allow a missing shared library or a downloaded-but-broken
  // executable to make the browser gate look green.
  console.error('BLOCKED CI Chromium: executable, shared libraries or DOM probe unavailable');
  process.exitCode = 2;
} finally {
  if (browser) await browser.close();
}
