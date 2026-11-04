import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync,
  symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const loader = fileURLToPath(new URL('../production-env-loader.sh', import.meta.url));
const deploy = readFileSync(new URL('../deploy-prod.sh', import.meta.url), 'utf8');
const secretOwner = 'OwnerReleaseKey123456789abcdef';
const secretRuntime = 'RuntimeReleaseKey123456789abcdef';
const env = [
  'POSTGRES_DB=sedeagro', 'POSTGRES_USER=sedeagro_owner',
  'POSTGRES_PASSWORD=' + secretOwner, 'APP_DB_USER=sedeagro_app',
  'APP_DB_PASSWORD=' + secretRuntime, 'LOG_LEVEL=info', ''
].join('\n');
const command = String.raw`
  set -euo pipefail
  source "$1"
  if production_load_db_env "$2"; then
    [[ "$POSTGRES_DB" == sedeagro &&
       "$POSTGRES_USER" == sedeagro_owner &&
       "$APP_DB_USER" == sedeagro_app &&
       "$POSTGRES_PASSWORD" == OwnerReleaseKey123456789abcdef &&
       "$APP_DB_PASSWORD" == RuntimeReleaseKey123456789abcdef ]] || exit 3
    printf 'ACCEPTED\n'
  else
    printf 'BLOCKED\n'
    exit 2
  fi
`;

function fixture(t, contents = env) {
  const dir = mkdtempSync(join(tmpdir(), 'sedeagro-safe-env-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, '.env');
  writeFileSync(file, contents, { mode: 0o600 });
  chmodSync(file, 0o600);
  const attempt = (args = [], runner = command) =>
    spawnSync('bash', [...args, '-c', runner, 'safe-env-test', loader, file],
      { encoding: 'utf8', timeout: 7000, env: { ...process.env } });
  return { dir, file, attempt };
}
function blocked(output) {
  assert.equal(output.status, 2, output.stderr + output.stdout);
  assert.doesNotMatch(output.stdout + output.stderr,
    /OwnerReleaseKey123456789abcdef|RuntimeReleaseKey123456789abcdef/);
  assert.doesNotMatch(output.stdout, /ACCEPTED/);
}

test('load only allowlisted production DB keys without sourcing dotenv', t => {
  const { dir, attempt } = fixture(t, env +
    'EXTRA=$(touch ' + join(tmpdir(), 'unreachable-extra-marker') + ')\n');
  const result = attempt();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(result.stdout.trim(), 'ACCEPTED');
  assert.doesNotMatch(result.stdout + result.stderr, /ReleaseKey/);
  assert.ok(dir);
});

test('reject duplicate, missing, multiline, unsafe names or insecure password', t => {
  const { file, attempt } = fixture(t);
  for (const value of [
    env + 'POSTGRES_PASSWORD=' + secretOwner + '\n',
    env.replace('POSTGRES_DB=sedeagro\n', ''),
    env.replace('POSTGRES_DB=sedeagro', 'POSTGRES_DB=prod;touch /tmp/unsafe'),
    env.replace('APP_DB_USER=sedeagro_app', 'APP_DB_USER=sedeagro_owner'),
    env.replace('POSTGRES_PASSWORD=' + secretOwner, 'POSTGRES_PASSWORD=short'),
    env.replace('APP_DB_PASSWORD=' + secretRuntime,
      'APP_DB_PASSWORD=' + secretRuntime + '\r'),
    env.replace('APP_DB_PASSWORD=' + secretRuntime,
      'APP_DB_PASSWORD=Bearer$(touch /tmp/unsafe)')
  ]) {
    writeFileSync(file, value);
    blocked(attempt());
  }
});

test('dotenv command substitution is inert even for a valid-looking extra key', t => {
  const dir = mkdtempSync(join(tmpdir(), 'sedeagro-no-eval-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const marker = join(dir, 'no-shell-code');
  const { file, attempt } = fixture(t, env + 'ANYTHING=$(touch ' + marker + ')\n');
  assert.equal(attempt().status, 0);
  assert.equal(existsSync(marker), false);
  writeFileSync(file, env.replace('POSTGRES_PASSWORD=' + secretOwner,
    'POSTGRES_PASSWORD=$(touch ' + marker + ')'));
  blocked(attempt());
  assert.equal(existsSync(marker), false);
});

test('reject symlink and oversized dotenv; fail without exposing values under xtrace', t => {
  const { dir, file, attempt } = fixture(t);
  blocked(attempt(['-x']));
  const tooLarge = env + 'PADDING=' + 'a'.repeat(65_536);
  writeFileSync(file, tooLarge);
  blocked(attempt());
  rmSync(file);
  writeFileSync(join(dir, 'target'), env);
  symlinkSync(join(dir, 'target'), file);
  blocked(attempt());
});

test('production deploy passes secrets by environment/stdin, not argv or shell evaluation', () => {
  assert.doesNotMatch(deploy, /^\s*(?:source|\.)\s+\.env\b/m);
  assert.match(deploy, /source scripts\/production-env-loader\.sh/);
  assert.match(deploy, /production_load_db_env \.env/);
  assert.match(deploy, /MIGRATION_DB_PASSWORD="\$POSTGRES_PASSWORD" docker compose run/);
  assert.match(deploy, /^\s+-e MIGRATION_DB_PASSWORD \\$/m);
  assert.doesNotMatch(deploy, /-e MIGRATION_DB_PASSWORD="\$POSTGRES_PASSWORD"/);
  assert.doesNotMatch(deploy, /-v "app_password=\$APP_DB_PASSWORD"/);
  assert.match(deploy, /printf '\\set app_password %s\\n' "\$APP_DB_PASSWORD"/);
  assert.match(deploy, /\} \| docker compose exec -T db psql/);
  assert.match(deploy, /bash scripts\/production-preflight\.sh/);
  assert.match(deploy, /docker compose build backend frontend/,
    'this PR deliberately does not remove the existing OCI release hard-stop');
  assert.doesNotMatch(deploy, /(?:^\s*set -x|psql[^\n]*-a\b)/m);
});
