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
      diagnostic = await dialog.evaluate(root => {
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
          firstFocusableTag: nodes[0]?.tagName?.toLowerCase() ?? null,
          lastFocusableTag: nodes.at(-1)?.tagName?.toLowerCase() ?? null
        };
      });
    } catch {
      diagnostic = { dialogMounted: false };
    }
    throw new Error('Dialog keyboard focus mismatch [' + checkpoint + '] ' +
      JSON.stringify(diagnostic));
  } finally {
    await element.dispose();
  }
}
