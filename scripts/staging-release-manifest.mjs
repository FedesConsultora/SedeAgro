// Deterministic manifest for a staging build. It cannot prove the deployed
// VPS SHA; verify the exact files against the manifest after copying artifacts.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'frontend/dist');
const manifestPath = resolve(root, 'staging-release-manifest.json');
const mode = process.argv[2] || 'create';
if (!['create', 'verify'].includes(mode)) throw new Error('Use create or verify');
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('Invalid Git HEAD');
if (process.env.VITE_API_URL && !/^\/api(?:\/|$)/.test(process.env.VITE_API_URL)) {
  throw new Error('Staging requires same-origin VITE_API_URL /api/v1');
}

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Build artifacts cannot contain symlinks');
    if (entry.isDirectory()) return files(path);
    if (!entry.isFile()) throw new Error('Unsupported artifact');
    const content = readFileSync(path);
    return [{ path: relative(dist, path).split('\\').join('/'),
      sha256: createHash('sha256').update(content).digest('hex'),
      size: statSync(path).size }];
  });
}
const generated = { schema: 'sedeagro-staging-build-v1', head: sha,
  files: files(dist).sort((a, b) => a.path.localeCompare(b.path)) };
if (!generated.files.some((file) => file.path === 'index.html') ||
    !generated.files.some((file) => file.path === 'sw.js')) {
  throw new Error('Incomplete Vite shell: index.html/sw.js missing');
}
if (mode === 'create') {
  writeFileSync(manifestPath, JSON.stringify(generated, null, 2) + '\n');
  console.log(`Created provenance for ${generated.files.length} files: ${sha}`);
} else {
  const expected = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (JSON.stringify(expected) !== JSON.stringify(generated)) {
    throw new Error('Staging artifacts differ from manifest or HEAD; refuse deployment');
  }
  console.log(`PASS: ${generated.files.length} hashed files match ${sha}`);
}
