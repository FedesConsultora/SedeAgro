#!/usr/bin/env bash
set -euo pipefail

# Read-only production gate. Never sources .env, runs Docker, migrates or writes data.
# A production deployment must name the exact reviewed main SHA and opt in
# explicitly. This script also works standalone, before touching a VPS.
fail() { printf 'BLOCKED production preflight: %s\n' "$1" >&2; exit 2; }

[[ $# -eq 0 ]] || fail "no arguments accepted; use SEDEAGRO_RELEASE_SHA and SEDEAGRO_DEPLOY_APPROVAL"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHA="${SEDEAGRO_RELEASE_SHA:-}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || fail "SEDEAGRO_RELEASE_SHA must be a 40-character lowercase commit SHA"
[[ "${SEDEAGRO_DEPLOY_APPROVAL:-}" == "DEPLOY:$SHA" ]] ||
  fail "explicit SEDEAGRO_DEPLOY_APPROVAL=DEPLOY:<full-SHA> is required"

for command in git grep stat; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required tool: $command"
done
[[ "$(git -C "$ROOT" symbolic-ref --quiet --short HEAD 2>/dev/null || true)" == main ]] ||
  fail "checkout must be on main, not a detached HEAD or feature branch"
[[ "$(git -C "$ROOT" rev-parse --verify HEAD 2>/dev/null || true)" == "$SHA" ]] ||
  fail "local HEAD does not match the approved SHA"
[[ "$(git -C "$ROOT" rev-parse --verify refs/remotes/origin/main 2>/dev/null || true)" == "$SHA" ]] ||
  fail "origin/main does not match the approved SHA (fetch the remote before deploy)"
[[ -z "$(git -C "$ROOT" status --porcelain --untracked-files=no 2>/dev/null)" ]] ||
  fail "tracked checkout has uncommitted changes"

secure_file() {
  local file="$1" label="$2" mode
  [[ -f "$file" && ! -L "$file" ]] || fail "$label is missing or a symlink"
  mode="$(stat -c '%a' "$file" 2>/dev/null)" || fail "cannot stat $label"
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || fail "$label has invalid Unix permissions"
  (( (8#$mode & 077) == 0 )) || fail "$label must not be readable/writable by group or others (chmod 600)"
}
secure_file "$ROOT/.env" ".env"
secure_file "$ROOT/backend/.env" "backend/.env"

# Intentionally accepts only simple, unquoted KEY=value for release-critical
# settings. This prevents ambiguous dotenv/bash parsing and never evaluates text.
value() {
  local file="$1" key="$2" lines
  lines="$(grep -E "^$key=" "$file" || true)"
  [[ -n "$lines" && "$lines" != *$'\n'* && "$lines" != *$'\r'* ]] ||
    fail "missing, duplicate or malformed $key in ${file#"$ROOT/"}"
  printf '%s' "${lines#*=}"
}
root="$ROOT/.env"
backend="$ROOT/backend/.env"

[[ "$(value "$backend" NODE_ENV)" == production ]] || fail "backend NODE_ENV must be production"
[[ "$(value "$backend" SEED_MODE)" == prod ]] || fail "backend SEED_MODE must be prod, never demo/dev"
[[ "$(value "$backend" LOG_SQL)" == 0 ]] || fail "backend LOG_SQL must be 0"
[[ "$(value "$backend" LOG_STACK)" == 0 ]] || fail "backend LOG_STACK must be 0"

domain="$(value "$backend" BASE_DOMAIN)"
origin="$(value "$backend" CORS_ORIGIN)"
[[ "$domain" == sedeagro.fedes.ai && "$origin" == "https://$domain" ]] ||
  fail "production requires BASE_DOMAIN=sedeagro.fedes.ai and its exact HTTPS CORS_ORIGIN"

jwt="$(value "$backend" JWT_SECRET)"
[[ ${#jwt} -ge 32 && "$jwt" =~ ^[A-Za-z0-9._~-]+$ ]] ||
  fail "backend JWT_SECRET must be a distinct, URL-safe secret of at least 32 characters"
case "${jwt,,}" in
  *replace*|*change*|*demo*|*example*|*password*|*secret*|*test*)
    fail "backend JWT_SECRET looks like a placeholder" ;;
esac

owner="$(value "$root" POSTGRES_USER)"
app="$(value "$root" APP_DB_USER)"
[[ "$owner" =~ ^[a-z_][a-z0-9_]*$ && "$app" =~ ^[a-z_][a-z0-9_]*$ && "$owner" != "$app" ]] ||
  fail "database runtime user must be a distinct, valid non-owner role"
for key in POSTGRES_PASSWORD APP_DB_PASSWORD; do
  credential="$(value "$root" "$key")"
  [[ ${#credential} -ge 24 && "$credential" =~ ^[A-Za-z0-9._~-]+$ ]] ||
    fail "$key must be a 24+ character URL-safe credential"
  case "${credential,,}" in
    *replace*|*change*|*demo*|*example*|*password*|*secret*|*test*)
      fail "$key looks like a placeholder" ;;
  esac
done

# A security-inventory CI success is not release acceptance. Refuse the
# production deploy while any moderate backend advisory remains unresolved.
# Run after Git/secret checks, still BEFORE Docker, backups or migrations.
command -v node >/dev/null 2>&1 || fail "Node.js required for release security admission"
if ! node "$ROOT/scripts/verify-production-security.mjs" \
  "$ROOT/scripts/security-moderate-baseline.json" "$ROOT/backend/package-lock.json"; then
  fail "security P0 unresolved; see issue #137 and approved release-security policy"
fi

# 0P.33: signed Syft/Trivy and OCI metadata MUST be admitted independently.
# DEPLOY:<SHA> and a green npm lock check are never approval of image risk.
# This gate intentionally denies release while signed CI says release_go=false
# or while deploy-prod.sh rebuilds images rather than consuming exact OCI bytes.
[[ -n "${SEDEAGRO_SIGNED_RELEASE_DIR:-}" ]] ||
  fail "signed OCI/security evidence directory is mandatory before deployment"
if ! node "$ROOT/scripts/verify-production-image-admission.mjs" \
  --sha "$SHA" --evidence-dir "$SEDEAGRO_SIGNED_RELEASE_DIR"; then
  fail "signed image risk, identity or immutable deployment admission denied"
fi

printf 'PASS read-only production preflight: clean main/origin/main at %s, restricted env permissions, prod-only config and explicit approval.\n' "$SHA"
printf 'NOT CERTIFIED: backup/restore of staging, live database readiness, mobile field acceptance or VPS cutover.\n'