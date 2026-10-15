// 0T.3: read-only comparison of the ACTUAL served public SPA bytes with
// the trusted CI release manifest. This is NOT a backend/DB release attestation.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MAX_FILES = 500;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 150 * 1024 * 1024;
const HEX40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const CHECKSUM_PATH = /^[a-zA-Z0-9._/-]+$/;
const LOOPBACK = new Set(['127.0.0.1', '[::1]']);

export function validateReleaseSource(baseUrl, allowLoopback = false) {
  let target;
  try { target = new URL(baseUrl); } catch { throw new Error('Staging URL inválida.'); }
  if (target.username || target.password || target.pathname !== '/' ||
      target.search || target.hash || !target.hostname) {
    throw new Error('Usá exclusivamente un origen sin ruta, credenciales ni parámetros.');
  }
  if (target.protocol === 'https:') {
    if (LOOPBACK.has(target.hostname) || target.hostname === 'localhost' ||
        target.hostname.endsWith('.localhost')) {
      throw new Error('El origen HTTPS de staging no puede ser loopback.');
    }
  } else if (target.protocol !== 'http:' || !allowLoopback ||
             !LOOPBACK.has(target.hostname)) {
    throw new Error('HTTPS es obligatorio; HTTP solo se permite en loopback explícito de CI.');
  }
  return target.origin;
}

export function validateReleaseManifest(manifest, expectedSha) {
  if (!HEX40.test(expectedSha || '') || !manifest ||
      manifest.schema !== 'sedeagro-staging-build-v1' ||
      manifest.head !== expectedSha || !Array.isArray(manifest.files) ||
      manifest.files.length < 2 || manifest.files.length > MAX_FILES) {
    throw new Error('Manifiesto inválido, incompleto o de un HEAD distinto.');
  }
  const paths = new Set();
  let total = 0;
  for (const item of manifest.files) {
    const name = item?.path;
    if (typeof name !== 'string' || name.length > 240 ||
        !CHECKSUM_PATH.test(name) || name.startsWith('/') ||
        name.endsWith('/') || name.includes('//') ||
        name.split('/').some(part => part === '.' || part === '..') ||
        paths.has(name) || !HEX64.test(item.sha256 || '') ||
        !Number.isSafeInteger(item.size) || item.size <= 0 ||
        item.size > MAX_FILE_BYTES) {
      throw new Error('Archivo inseguro, duplicado o sin hash válido en el manifiesto.');
    }
    paths.add(name);
    total += item.size;
    if (total > MAX_TOTAL_BYTES) throw new Error('Manifiesto supera el tamaño seguro para verificación.');
  }
  if (!paths.has('index.html') || !paths.has('sw.js') ||
      ![...paths].some(path => path.startsWith('assets/'))) {
    throw new Error('El manifiesto no contiene index.html, sw.js y assets versionados.');
  }
  return manifest.files;
}

async function fetchFile(url, expected, fetchImpl) {
  const response = await fetchImpl(url, {
    method: 'GET', redirect: 'error', credentials: 'omit',
    headers: { 'Cache-Control': 'no-store' },
    signal: AbortSignal.timeout(15000)
  });
  if (response.status !== 200 || response.redirected ||
      (response.url && response.url !== url)) {
    throw new Error(`La ruta publicada no respondió 200 sin redirección: ${expected.path}`);
  }
  const cache = response.headers.get('cache-control') || '';
  if (expected.path === 'index.html' || expected.path === 'sw.js') {
    if (!/no-cache|no-store|max-age=0/i.test(cache)) {
      throw new Error(`Falta revalidación de caché para ${expected.path}`);
    }
  } else if (expected.path.startsWith('assets/')) {
    if (!/max-age=[1-9][0-9]{6,}/i.test(cache)) {
      throw new Error(`Asset sin política de caché versionada: ${expected.path}`);
    }
  }
  const hash = createHash('sha256');
  let bytes = 0;
  const html = expected.path === 'index.html' ? [] : null;
  if (!response.body) throw new Error(`No hay cuerpo verificable para ${expected.path}`);
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_FILE_BYTES || bytes > expected.size) {
        throw new Error(`El archivo publicado tiene tamaño inesperado: ${expected.path}`);
      }
      hash.update(value);
      if (html) html.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (bytes !== expected.size || hash.digest('hex') !== expected.sha256) {
    throw new Error(`HASH/TAMAÑO DISTINTO del manifiesto: ${expected.path}`);
  }
  return html ? Buffer.concat(html).toString('utf8') : null;
}

export async function verifyDeployedStaging({
  baseUrl, expectedSha, manifest, allowLoopback = false,
  fetchImpl = fetch
}) {
  const root = validateReleaseSource(baseUrl, allowLoopback);
  const files = validateReleaseManifest(manifest, expectedSha);
  const publicPaths = new Set(files.map(item => item.path));
  let html = '';
  // Sequential and bounded: a failed file stops verification immediately.
  for (const item of files) {
    const path = '/' + item.path;
    const value = await fetchFile(root + path, item, fetchImpl);
    if (item.path === 'index.html') html = value;
  }
  const referenced = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)]
    .map(match => match[1]);
  if (!referenced.length || referenced.some(path =>
    path.includes('?') || path.includes('#') || !publicPaths.has(path.slice(1)))) {
    throw new Error('index.html referencia assets no cubiertos por el manifiesto.');
  }
  // Root navigation and /index.html must be the same exact shell bytes;
  // this detects stale edge caches and inconsistent proxy routing.
  const shell = files.find(item => item.path === 'index.html');
  const shellHtml = await fetchFile(root + '/', { ...shell, path: 'index.html' }, fetchImpl);
  if (shellHtml !== html) throw new Error('La raíz sirve un HTML distinto de /index.html.');
  return { head: expectedSha, filesVerified: files.length,
    bytesVerified: files.reduce((sum, item) => sum + item.size, 0) + shell.size };
}

async function main() {
  const args = process.argv.slice(2);
  const get = name => {
    const index = args.indexOf(name);
    return index === -1 ? null : args[index + 1];
  };
  const permitted = new Set(['--url', '--sha', '--manifest', '--ci-loopback']);
  if (args.some((arg, index) =>
    (arg.startsWith('--') && !permitted.has(arg)) ||
    (!arg.startsWith('--') && (index === 0 || !['--url', '--sha', '--manifest'].includes(args[index - 1]))))) {
    throw new Error('Argumentos no reconocidos.');
  }
  const loopback = args.includes('--ci-loopback') &&
    process.env.SEDEAGRO_CI_LOOPBACK === '1';
  if (!get('--url') || !get('--sha') || !get('--manifest')) {
    throw new Error('Uso: --url https://staging.ejemplo --sha SHA40 --manifest archivo.json');
  }
  const manifest = JSON.parse(readFileSync(get('--manifest'), 'utf8'));
  const result = await verifyDeployedStaging({
    baseUrl: get('--url'), expectedSha: get('--sha'),
    manifest, allowLoopback: loopback
  });
  console.log(`PASS: ${result.filesVerified} archivos y shell / coinciden byte a byte con ${result.head}`);
  console.log('PENDIENTE: digest de backend, migraciones, RLS staging, backup/restauración y QA móvil físico.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => {
    console.error('BLOCKED staging artifact:', error.message);
    process.exitCode = 1;
  });
}
