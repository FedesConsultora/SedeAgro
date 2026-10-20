// Focus stress can only raise acceptance coverage, never silently skip cycles.
// Bounded for the disposable PostgreSQL + real Chromium GitHub CI runner.
export function getFocusStressCycles(env = process.env) {
  const raw = env.SEDEAGRO_FOCUS_STRESS_CYCLES;
  if (raw === undefined || raw === '') return 4;
  if (env.CI !== 'true' || env.GITHUB_ACTIONS !== 'true' ||
      !/^(?:[4-9]|1[0-6])$/.test(raw)) {
    throw new Error('BLOCKED: focus stress needs disposable GitHub CI and 4..16 complete real-browser cycles');
  }
  return Number(raw);
}
