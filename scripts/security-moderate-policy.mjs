// Fail-closed drift detector for OPEN moderate vulnerabilities already inventoried
// in the deployed backend lockfile. This is NOT a release risk acceptance.
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const safePackage = name => /^[a-zA-Z0-9@._/-]{1,150}$/.test(name);
const validDate = date => {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const time = Date.parse(date + 'T00:00:00.000Z');
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date;
};

export function enforceModerateInventory(summary, policy, lock, today = new Date()) {
  if (!summary || typeof summary !== 'object' ||
      summary.scope !== 'backend-runtime' ||
      !Number.isSafeInteger(summary.moderate) || summary.moderate < 0 ||
      !Array.isArray(summary.affected) ||
      !policy || policy.schema !== 1 || policy.scope !== summary.scope ||
      policy.status !== 'unaccepted-for-release' ||
      !Number.isSafeInteger(policy.maxModerate) || policy.maxModerate < 0 ||
      !validDate(policy.reviewBy) || !policy.packages ||
      typeof policy.packages !== 'object' || Array.isArray(policy.packages) ||
      !lock || lock.lockfileVersion !== 3 || !lock.packages ||
      typeof lock.packages !== 'object' || Array.isArray(lock.packages) ||
      !(today instanceof Date) || !Number.isFinite(today.getTime())) {
    throw new Error('BLOCKED: malformed backend moderate-vulnerability inventory or lockfile');
  }
  if (today.toISOString().slice(0, 10) > policy.reviewBy) {
    throw new Error('BLOCKED: backend moderate-risk review deadline expired; refresh explicit security assessment');
  }
  const registered = Object.entries(policy.packages);
  if (registered.length !== policy.maxModerate ||
      registered.some(([name, item]) =>
        !safePackage(name) || !item || typeof item !== 'object' ||
        typeof item.version !== 'string' ||
        !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(item.version) ||
        !Array.isArray(item.titles) ||
        item.titles.length > 5 ||
        item.titles.some(title => typeof title !== 'string' || title.length > 110) ||
        new Set(item.titles).size !== item.titles.length)) {
    throw new Error('BLOCKED: invalid or unreviewed backend moderate-risk baseline');
  }
  if (summary.moderate > policy.maxModerate) {
    throw new Error('BLOCKED: backend moderate advisories increased beyond reviewed inventory');
  }
  const current = summary.affected.filter(a => a.severity === 'moderate');
  if (current.length !== summary.moderate) {
    throw new Error('BLOCKED: incomplete moderate advisory list; refusing truncated or inconsistent audit');
  }
  if (new Set(current.map(item => item.package)).size !== current.length) {
    throw new Error('BLOCKED: duplicate moderate packages in audit');
  }
  for (const item of current) {
    if (!item || !own(policy.packages, item.package)) {
      throw new Error('BLOCKED: new backend moderate advisory package requires explicit security review');
    }
    const expected = policy.packages[item.package];
    const installed = lock.packages['node_modules/' + item.package];
    if (!installed || installed.version !== expected.version) {
      throw new Error('BLOCKED: changed vulnerable dependency version requires re-audit: ' + item.package);
    }
    if (!Array.isArray(item.via) ||
        JSON.stringify([...item.via].sort()) !== JSON.stringify([...expected.titles].sort())) {
      throw new Error('BLOCKED: new/modified upstream moderate advisory requires review: ' + item.package);
    }
  }
  return {
    scope: summary.scope, openModerate: summary.moderate,
    maxModerate: policy.maxModerate, reviewBy: policy.reviewBy,
    releaseAccepted: false, policy: 'inventory-only'
  };
}
