// Real Chromium focus assertions with deliberately MINIMAL failure telemetry.
// Never expose input values, element text, labels, IDs, private routes or HTML.
export async function assertDialogFocus(page, dialog, target, checkpoint) {
  if (typeof checkpoint !== 'string' || !/^[a-z0-9-]{1,64}$/.test(checkpoint)) {
    throw new Error('Static focus-checkpoint identifier required');
  }
  const element = await target.elementHandle();
  if (!element) throw new Error('Expected focus target is not mounted: ' + checkpoint);
  try {
    // Wait for one bounded browser rendering turn; do NOT retry interactions,
    // focus targets programmatically, or silently waive the focus contract.
    await page.waitForFunction(
      expected => document.activeElement === expected, element,
      { polling: 'raf', timeout: 750 }
    );
  } catch {
    let diagnostic;
    try {
      diagnostic = await dialog.evaluate((root, expected) => {
        const active = document.activeElement;
        const nodes = Array.from(root.querySelectorAll(
          'button, input, select, textarea, a[href], [tabindex]'
        )).filter(node => node.getClientRects().length > 0 && !node.disabled);
        return {
          dialogMounted: root.isConnected,
          activeInsideDialog: root.contains(active),
          activeIsDialogRoot: root === active,
          activeTag: active?.tagName?.toLowerCase() ?? null,
          activeRole: active?.getAttribute('role') ?? null,
          activeDisabled: Boolean(active?.disabled),
          focusableCount: nodes.length,
          activeFocusableIndex: nodes.indexOf(active),
          expectedFocusableIndex: nodes.indexOf(expected),
          expectedDisabled: Boolean(expected?.disabled),
          firstFocusableTag: nodes[0]?.tagName?.toLowerCase() ?? null,
          lastFocusableTag: nodes.at(-1)?.tagName?.toLowerCase() ?? null
        };
      }, element);
    } catch {
      diagnostic = { dialogMounted: false };
    }
    throw new Error('Dialog keyboard focus mismatch [' + checkpoint + '] ' +
      JSON.stringify(diagnostic));
  } finally {
    await element.dispose();
  }
}

// The last enabled tab stop can change while an asynchronous form lookup
// settles. Capture the precise boundary at keydown CAPTURE phase, before
// Modal's bubble-phase trap handles Tab. This tests the user's real contract:
// focus must go to the last CURRENTLY enabled control, not a stale guess.
export async function pressReverseTabAtDialogRoot(page, dialog, checkpoint) {
  if (typeof checkpoint !== 'string' || !/^[a-z0-9-]{1,64}$/.test(checkpoint)) {
    throw new Error('Static focus-checkpoint identifier required');
  }
  await dialog.evaluate(root => {
    window.__sedeagroTabProbe = { expected: null, captured: false, focusableCount: 0 };
    document.addEventListener('keydown', event => {
      if (event.key !== 'Tab' || !event.shiftKey) return;
      const focusable = Array.from(root.querySelectorAll([
        'a[href]', 'button:not([disabled])', 'input:not([disabled])',
        'select:not([disabled])', 'textarea:not([disabled])',
        '[tabindex]:not([tabindex="-1"])'
      ].join(', '))).filter(node =>
        node.getAttribute('aria-hidden') !== 'true' &&
        node.getAttribute('tabindex') !== '-1' &&
        node.getClientRects().length > 0);
      window.__sedeagroTabProbe = {
        expected: focusable.at(-1) ?? root,
        captured: true, focusableCount: focusable.length
      };
    }, { capture: true, once: true });
  });
  try {
    await page.keyboard.press('Shift+Tab');
    await page.waitForFunction(() => {
      const probe = window.__sedeagroTabProbe;
      return probe?.captured && document.activeElement === probe.expected;
    }, null, { polling: 'raf', timeout: 750 });
  } catch {
    const snapshot = await dialog.evaluate(root => {
      const probe = window.__sedeagroTabProbe;
      const active = document.activeElement;
      return {
        eventCaptured: Boolean(probe?.captured),
        focusableCountAtKeydown: probe?.focusableCount ?? null,
        expectedDisabledNow: Boolean(probe?.expected?.disabled),
        activeIsExpectedAtKeydown: Boolean(probe?.expected && active === probe.expected),
        activeInsideDialog: root.contains(active),
        activeIsRoot: active === root,
        activeTag: active?.tagName?.toLowerCase() ?? null,
        expectedTag: probe?.expected?.tagName?.toLowerCase() ?? null
      };
    });
    throw new Error('Dialog actual-keydown boundary mismatch [' + checkpoint + '] ' +
      JSON.stringify(snapshot));
  } finally {
    await page.evaluate(() => { delete window.__sedeagroTabProbe; });
  }
}
