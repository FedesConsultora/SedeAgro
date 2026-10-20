// Print only changed npm lock entries from a disposable CI security repair.
// This does not commit, install, or change checked-in files by itself.
import { readFileSync } from 'node:fs';

const [service, beforePath, afterPath] = process.argv.slice(2);
if (!['backend', 'frontend'].includes(service) || !beforePath || !afterPath) {
  throw new Error('Usage: security-lock-delta.mjs backend|frontend old.json new.json');
}
function load(path) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (value.lockfileVersion !== 3 || !value.packages ||
      typeof value.packages !== 'object') {
    throw new Error('Expected npm v3 lockfile from the checked out project');
  }
  return value;
}
const before = load(beforePath);
const after = load(afterPath);
if (before.name !== after.name) throw new Error('Cannot compare different npm projects');
function ordered(o) {
  if (Array.isArray(o)) return o.map(ordered);
  if (o && typeof o === 'object')
    return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, ordered(value)]));
  return o;
}
const changes = {};
for (const key of new Set([...Object.keys(before.packages), ...Object.keys(after.packages)])) {
  if (JSON.stringify(ordered(before.packages[key])) !== JSON.stringify(ordered(after.packages[key]))) {
    changes[key] = after.packages[key] ?? null;
  }
}
if (Object.keys(changes).length > 350) throw new Error('Too many lockfile differences to review');
console.log('LOCK_DELTA_JSON=' + JSON.stringify({ service, changes }));
console.log('LOCK_DELTA_COUNT=' + service + ':' + Object.keys(changes).length);
