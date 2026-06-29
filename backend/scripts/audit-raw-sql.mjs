import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const root = new URL('../src', import.meta.url).pathname;
const allowed = new Set([
  'core/db.js',
  'infra/db/rawScope.js',
  'infra/db/migrate.js',
  'infra/db/seed.js'
]);

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) return walk(fullPath);
    return entry.name.endsWith('.js') ? [fullPath] : [];
  }));
  return files.flat();
}

const failures = [];
for (const file of await walk(root)) {
  const rel = relative(root, file);
  if (allowed.has(rel)) continue;
  const content = await readFile(file, 'utf8');
  if (content.includes('sequelize.query(')) {
    failures.push(rel);
  }
}

if (failures.length) {
  console.error('Uso directo de sequelize.query bloqueado. Usá queryTenant():');
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log('Raw SQL audit OK: sin sequelize.query directo fuera de helpers.');
