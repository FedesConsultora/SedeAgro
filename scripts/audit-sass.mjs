import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = new URL('../frontend/src', import.meta.url);
const forbidden = [
  { pattern: /@import\b/, message: 'Usá @use en lugar de @import.' },
  { pattern: /\bdarken\s*\(/, message: 'darken() está deprecada; usá sass:color.' },
  { pattern: /\blighten\s*\(/, message: 'lighten() está deprecada; usá sass:color.' }
];

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(path);
    return path.endsWith('.scss') ? [path] : [];
  }));
  return files.flat();
}

const files = await listFiles(root.pathname);
const failures = [];

for (const file of files) {
  const content = await readFile(file, 'utf8');
  for (const rule of forbidden) {
    if (rule.pattern.test(content)) {
      failures.push(`${file}: ${rule.message}`);
    }
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log('Sass audit OK: @use activo y sin darken/lighten.');
