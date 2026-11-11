import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync,
  rmSync, symlinkSync, utimesSync, writeFileSync
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceScript = fileURLToPath(new URL('../verify-production-backup.sh', import.meta.url));
const release = 'a'.repeat(40);
const archiveData = Buffer.alloc(8192, 0x5a);

function fixture(t) {
  // Home directory avoids /tmp, which is explicitly forbidden by production.
  const work = mkdtempSync(join(homedir(), '.sedeagro-backup-gate-test-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const project = join(work, 'project');
  const dir = join(work, 'backups');
  const bin = join(work, 'bin');
  mkdirSync(join(project, 'scripts'), { recursive: true });
  mkdirSync(dir, { mode: 0o700 });
  mkdirSync(bin, { mode: 0o700 });
  chmodSync(dir, 0o700);
  copyFileSync(sourceScript, join(project, 'scripts/verify-production-backup.sh'));
  writeFileSync(join(project, 'docker-compose.yml'), 'name: sedeagro\n');
  const archive = join(dir, 'pre-release.dump');
  writeFileSync(archive, archiveData, { mode: 0o600 });
  chmodSync(archive, 0o600);
  const checksum = createHash('sha256').update(archiveData).digest('hex');
  const logFile = join(work, 'docker.calls');
  const mockDocker = join(bin, 'docker');
  const mock = [
    '#!/usr/bin/env bash',
    'echo "$*" >> "$MOCK_DOCKER_LOG"',
    'if [[ "$1" == compose ]]; then',
    '  [[ "$2" == --project-directory && "$3" == "$MOCK_PROJECT" &&',
    '    "$4" == --file && "$5" == "$MOCK_PROJECT/docker-compose.yml" &&',
    '    "$6" == --project-name && "$7" == sedeagro ]] || exit 61',
    '  if [[ "$8" == ps && "$9" == --quiet && "${10}" == db ]]; then',
    '    if [[ "${MOCK_SWAP_DB:-}" == 1 && -f "$MOCK_SWAP_MARKER" ]]; then',
    '      printf "%064d\\n" 1; exit 0',
    '    fi',
    '    echo "$MOCK_DB_ID"; exit 0',
    '  fi',
    '  [[ "$8" == exec && "$9" == -T && "${10}" == db &&',
    '    "${11}" == pg_restore && "${12}" == --list ]] || exit 62',
    '  if [[ "${MOCK_FAIL_DOCKER:-}" == 1 ]]; then exit 55; fi',
    '  cat >/dev/null',
    '  touch "$MOCK_SWAP_MARKER"',
    '  if [[ "${MOCK_MUTATE_ARCHIVE:-}" == 1 ]]; then',
    '    printf X >> "$MOCK_ARCHIVE_PATH"',
    '  fi',
    '  case "${MOCK_TOC_CASE:-valid}" in',
    '    missing) echo "19; 1259 456 TABLE public tenants owner"; exit 0 ;;',
    '  esac',
    '  n=90',
    '  for table in sequelize_migrations tenants auth_sessions fields work_orders evidence_blobs; do',
    '    if [[ "$table" == work_orders && -n "${MOCK_TOC_CASE:-}" && "$MOCK_TOC_CASE" != valid ]]; then',
    '      case "$MOCK_TOC_CASE" in',
    '        comment) echo "; 1259 999 TABLE public work_orders owner" ;;',
    '        data) echo "120; 0 999 TABLE DATA public work_orders owner" ;;',
    '        prefix) echo "120; 1259 999 TABLE public work_orders_archive owner" ;;',
    '        schema) echo "120; 1259 999 TABLE audit work_orders owner" ;;',
    '        view) echo "120; 1259 999 VIEW public work_orders owner" ;;',
    '        malformed) echo "bad; 1259 999 TABLE public work_orders owner" ;;',
    '        duplicate) echo "120; 1259 999 TABLE public work_orders owner"; echo "121; 1259 1000 TABLE public work_orders owner" ;;',
    '      esac',
    '    else',
    '      echo "$n; 1259 999 TABLE public $table owner"',
    '    fi',
    '    ((n+=1))',
    '  done',
    '  exit 0',
    'fi',
    'if [[ "$1" == inspect && "$2" == --type=container &&',
    '  "$3" == --format && "$5" == "$MOCK_DB_ID" ]]; then',
    '  actual="$MOCK_DB_ID|/sedeagro_db|sedeagro|db|postgis/postgis:16-3.4@sha256:44126d872ac91993766c341e369c539e8196614321765d36a6f1bab0419a5fa5|true|healthy"',
    '  case "${MOCK_INSPECT_CASE:-valid}" in',
    '    project) actual="${actual/|sedeagro|db|/|foreign|db|}" ;;',
    '    service) actual="${actual/|sedeagro|db|/|sedeagro|redis|}" ;;',
    '    image) actual="${actual/postgis\\/postgis:16-3.4@sha256:/postgis\\/postgis:latest@sha256:}" ;;',
    '    name) actual="${actual/|\\/sedeagro_db|/|\\/other_db|}" ;;',
    '    health) actual="${actual/|true|healthy/|true|unhealthy}" ;;',
    '    stopped) actual="${actual/|true|healthy/|false|healthy}" ;;',
    '  esac',
    '  echo "$actual"; exit 0',
    'fi',
    'exit 63'
  ].join('\n');
  writeFileSync(mockDocker, mock, { mode: 0o700 });
  chmodSync(mockDocker, 0o700);
  const env = {
    ...process.env,
    PATH: bin + ':' + (process.env.PATH || '/usr/bin:/bin'),
    SEDEAGRO_RELEASE_SHA: release,
    SEDEAGRO_VERIFIED_BACKUP_FILE: archive,
    SEDEAGRO_VERIFIED_BACKUP_SHA256: checksum,
    SEDEAGRO_RESTORE_APPROVAL: 'RESTORED:' + release + ':' + checksum,
    MOCK_DOCKER_LOG: logFile,
    MOCK_PROJECT: project,
    MOCK_DB_ID: 'd'.repeat(64),
    MOCK_SWAP_MARKER: join(work, 'toc.was.read'),
    MOCK_ARCHIVE_PATH: archive
  };
  function attempt(overrides = {}, args = []) {
    return spawnSync('bash', [join(project, 'scripts/verify-production-backup.sh'), ...args],
      { cwd: project, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 10000 });
  }
  return { work, project, dir, archive, checksum, logFile, attempt };
}

function blocked(result) {
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /BLOCKED backup gate/);
  assert.doesNotMatch(result.stdout, /PASS read-only/);
}

test('accepts a recent private archive after matching digest, TOC and attestation', t => {
  const f = fixture(t);
  const result = f.attempt();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS read-only backup gate/);
  assert.match(readFileSync(f.logFile, 'utf8'), /--project-name sedeagro exec -T db pg_restore --list/);
  assert.doesNotMatch(result.stdout, /private_password|localhost:5432/);
});

test('requires exact release, checksum and human-restored attestation', t => {
  const f = fixture(t);
  blocked(f.attempt({ SEDEAGRO_RELEASE_SHA: '' }));
  blocked(f.attempt({ SEDEAGRO_VERIFIED_BACKUP_SHA256: 'bad' }));
  blocked(f.attempt({ SEDEAGRO_RESTORE_APPROVAL: 'ok' }));
  blocked(f.attempt({ SEDEAGRO_VERIFIED_BACKUP_SHA256: 'b'.repeat(64),
    SEDEAGRO_RESTORE_APPROVAL: 'RESTORED:' + release + ':' + 'b'.repeat(64) }));
});

test('does not invoke Docker for rejected digest, approval or archive permissions', t => {
  const f = fixture(t);
  blocked(f.attempt({ SEDEAGRO_RESTORE_APPROVAL: 'yes' }));
  assert.equal(existsSync(f.logFile), false);
  chmodSync(f.archive, 0o644);
  blocked(f.attempt());
  assert.equal(existsSync(f.logFile), false);
  chmodSync(f.archive, 0o600);
  chmodSync(f.dir, 0o755);
  blocked(f.attempt());
  assert.equal(existsSync(f.logFile), false);
});

test('rejects symlinks, path traversal and backups under the checkout', t => {
  const f = fixture(t);
  const symlink = join(f.dir, 'link.dump');
  symlinkSync(f.archive, symlink);
  blocked(f.attempt({ SEDEAGRO_VERIFIED_BACKUP_FILE: symlink }));
  blocked(f.attempt({ SEDEAGRO_VERIFIED_BACKUP_FILE: f.dir + '/../backups/pre-release.dump' }));
  const inRepo = join(f.project, 'inside.dump');
  writeFileSync(inRepo, archiveData, { mode: 0o600 });
  blocked(f.attempt({ SEDEAGRO_VERIFIED_BACKUP_FILE: inRepo }));
});

test('rejects a backup older than 24h or unexpectedly small', t => {
  const f = fixture(t);
  const old = new Date(Date.now() - 26 * 60 * 60 * 1000);
  utimesSync(f.archive, old, old);
  blocked(f.attempt());
  const recent = new Date();
  utimesSync(f.archive, recent, recent);
  writeFileSync(f.archive, Buffer.alloc(100));
  blocked(f.attempt());
});

test('fails closed if pg_restore fails or expected schema objects are absent', t => {
  const f = fixture(t);
  blocked(f.attempt({ MOCK_FAIL_DOCKER: '1' }));
  blocked(f.attempt({ MOCK_TOC_CASE: 'missing' }));
  assert.match(readFileSync(f.logFile, 'utf8'), /pg_restore --list/);
});


test('rejects fake TOC presence in comments, TABLE DATA, wrong schemas, prefixes and duplicate table definitions',t=>{
  const f=fixture(t);
  for(const attack of ['missing','comment','data','prefix','schema','view','malformed','duplicate']){
    const result=f.attempt({MOCK_TOC_CASE:attack});
    blocked(result);
    assert.match(result.stderr,/exact required public table definitions/);
    assert.doesNotMatch(result.stdout,/PASS read-only backup gate/);
  }
  const safe=f.attempt({MOCK_TOC_CASE:'valid'});
  assert.equal(safe.status,0,safe.stderr);
});

test('TOC validation is structural, exact and read-only',()=>{
  const code=readFileSync(sourceScript,'utf8');
  assert.match(code,/\$4 == "TABLE" && \$5 == "public"/);
  assert.match(code,/\$6 in expected/);
  assert.match(code,/expected\[\$6\]\+\+/);
  assert.doesNotMatch(code,/grep -qF "\$required"/);
  assert.doesNotMatch(code,/docker compose (?:up|down|run)|\bpg_restore\s+--dbname/);
});

test('rejects Docker and Compose inherited overrides before any daemon interaction', t=>{
  const f=fixture(t);
  for(const [key,value] of [
    ['DOCKER_HOST','tcp://example.invalid:2375'],
    ['DOCKER_CONTEXT','remote'],
    ['DOCKER_CONFIG','/tmp/suspicious'],
    ['COMPOSE_FILE','/tmp/foreign.yml'],
    ['COMPOSE_PROJECT_NAME','foreign'],
    ['COMPOSE_ENV_FILES','/tmp/foreign.env'],
    ['COMPOSE_PROFILES','debug'],
    ['COMPOSE_PATH_SEPARATOR',':'],
    ['COMPOSE_IGNORE_ORPHANS','true']
  ]){
    blocked(f.attempt({[key]:value}));
    assert.equal(existsSync(f.logFile),false,key);
  }
});

test('rejects wrong production DB identity, unhealthy images and swapped DB containers',t=>{
  for(const variant of ['project','service','image','name','health','stopped']){
    const f=fixture(t);
    blocked(f.attempt({MOCK_INSPECT_CASE:variant}));
    assert.doesNotMatch(readFileSync(f.logFile,'utf8'),/exec -T db pg_restore/);
  }
  const f=fixture(t);
  blocked(f.attempt({MOCK_SWAP_DB:'1'}));
  assert.match(readFileSync(f.logFile,'utf8'),/exec -T db pg_restore/);
});

test('detects archive digest mutation while pg_restore lists its TOC',t=>{
  const f=fixture(t);
  const bad=f.attempt({MOCK_MUTATE_ARCHIVE:'1'});
  blocked(bad);
  assert.match(bad.stderr,/backup changed while pg_restore/);
});

test('rejects missing reviewed Compose file and does not reach Docker',t=>{
  const f=fixture(t);
  rmSync(join(f.project,'docker-compose.yml'));
  blocked(f.attempt());
  assert.equal(existsSync(f.logFile),false);
});

test('rejects arbitrary arguments and does not mutate a database', t => {
  const f = fixture(t);
  blocked(f.attempt({}, ['--apply']));
  const source = readFileSync(sourceScript, 'utf8');
  assert.doesNotMatch(source, /docker compose (?:up|down|run)|\bpg_restore\s+--dbname/);
  assert.doesNotMatch(source, /\bpg_dump\b|\bDROP DATABASE\b/);
});
