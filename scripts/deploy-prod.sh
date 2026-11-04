#!/usr/bin/env bash
# Prevent inherited xtrace from logging production secrets.
set +x
set -euo pipefail

# 0P.38: exclude competing deploys across checkout/worktree paths on THIS host.
# Fail closed before any git pull, signed admission, Docker or migration.
# /run/lock/sedeagro must be a private namespace owned by the deploy UID;
# the sourced helper retains its flock FD until this process exits.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if ! source "$SCRIPT_DIR/production-deploy-lock.sh" /run/lock/sedeagro; then
  printf 'BLOCKED: exclusive host deployment lock could not be acquired.\n' >&2
  exit 2
fi

echo "====================================="
echo "  SedeAgro - Deploy Producción"
echo "====================================="

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

if [[ ! -f .env || ! -f backend/.env ]]; then
  echo "Se requieren .env y backend/.env; consultar los archivos .env.example." >&2
  exit 1
fi

# Never pull into a different branch or start a production operation from
# modified tracked files. A skip-pull switch would leave the remote unverifiable.
if [[ -n "${SKIP_GIT_PULL:-}" ]]; then
  echo "BLOCKED: SKIP_GIT_PULL is not allowed for a production release." >&2
  exit 2
fi
if [[ "$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)" != "main" ||
      -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "BLOCKED: production checkout must be clean and on main BEFORE pull." >&2
  exit 2
fi
git pull --ff-only origin main

# Read-only, fail-closed gate AFTER fetch, BEFORE Docker build or migration.
# Requires the exact approved SHA and an explicit matching deployment approval.
bash scripts/production-preflight.sh

# Compose reads .env itself. NEVER source untrusted dotenv text as shell:
# parse only five required values without eval or emitting credentials.
# The helper is committed code from the exact reviewed SHA, not a dotenv file.
if ! source scripts/production-env-loader.sh || ! production_load_db_env .env; then
  echo "BLOCKED: producción requiere credenciales de BD seguras y no ambiguas en .env." >&2
  exit 2
fi

if ! grep -Eq '^NODE_ENV=production[[:space:]]*$' backend/.env; then
  echo "backend/.env debe tener NODE_ENV=production antes de desplegar." >&2
  exit 1
fi

echo "Construyendo imágenes sin detener el backend actual..."
docker compose build backend frontend

echo "Preparando los servicios de base de datos..."
docker compose up -d db redis

echo "Esperando a PostgreSQL..."
ready=0
for _ in $(seq 1 30); do
  if docker compose exec -T db pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done
if [[ "$ready" -ne 1 ]]; then
  echo "PostgreSQL no respondió después de 60 segundos." >&2
  exit 1
fi

# Backup must have been made and RESTORED on an isolated instance by the operator.
# This read-only check binds that external approval to the archive digest and
# exact release SHA. Refuse ALL migrations if it cannot be independently listed.
# A fresh PostgreSQL/PostGIS volume cannot contain SedeAgro tables to back
# up. Allow the one-time FIRST_DEPLOY approval only after proving via SQL that
# the schema has no non-extension relations or foreign user schemas.
# ALL upgrades must use a recent backup and a human-verified restore.
if [[ -n "${SEDEAGRO_INITIAL_BOOTSTRAP_APPROVAL:-}" ]]; then
  echo "Verificando instalación inicial sobre una base probadamente vacía..."
  bash scripts/verify-fresh-install-db.sh
else
  echo "Verificando respaldo externo aprobado antes de migraciones..."
  bash scripts/verify-production-backup.sh
fi

# Migrations execute with the schema owner, never with the HTTP server's limited role.
echo "Aplicando migraciones y catálogo global con rol propietario..."
MIGRATION_DB_PASSWORD="$POSTGRES_PASSWORD" docker compose run --rm --no-deps \
  -e MIGRATION_DB_USER="$POSTGRES_USER" \
  -e MIGRATION_DB_PASSWORD \
  -e MIGRATION_DB_NAME="$POSTGRES_DB" \
  backend sh -ec '
    DATABASE_URL="$(node -e '\''const p=process.env; const user=encodeURIComponent(p.MIGRATION_DB_USER); const pass=encodeURIComponent(p.MIGRATION_DB_PASSWORD); const db=encodeURIComponent(p.MIGRATION_DB_NAME); process.stdout.write("postgres://"+user+":"+pass+"@db:5432/"+db);'\'')" \
      node src/infra/db/migrate.js up && node src/infra/db/seed.js up
  '

echo "Provisionando permisos mínimos del usuario de la aplicación..."
# psql -v app_password=... leaks credentials via /proc/*/cmdline. Pass a
# validated URL-safe literal only via stdin, before the reviewed SQL script.
# Do not add -a/-e/echo-all to psql: those options would echo secrets.
{
  printf '\set app_password %s\n' "$APP_DB_PASSWORD"
  cat scripts/provision-runtime-role.sql
} | docker compose exec -T db psql \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
  -v "db_owner=$POSTGRES_USER" \
  -v "app_user=$APP_DB_USER"

echo "Recreando backend y frontend con credenciales de aplicación no privilegiadas..."
docker compose up -d --no-deps backend frontend

# Liveness /health is not sufficient: require actual runtime DB readiness.
# Keep the global proxy reload after both the API and SPA pass. This does NOT
# make an in-place Compose replacement an atomic / zero-downtime cutover.
echo "Esperando readiness PostgreSQL real desde el frontend interno..."
ready=0
for _ in $(seq 1 30); do
  if docker compose exec -T frontend \
    wget -qO- http://sedeagro_backend:3001/health/ready 2>/dev/null |
      grep -q '"ready":true'; then
    ready=1
    break
  fi
  sleep 2
done
if [[ "$ready" -ne 1 ]]; then
  echo "BLOCKED: nueva API no alcanzó /health/ready. No declarar deploy exitoso ni recargar proxy." >&2
  exit 1
fi
if ! docker compose exec -T frontend \
  wget -qO- http://127.0.0.1/index.html >/dev/null 2>&1; then
  echo "BLOCKED: nueva SPA interna no respondió 200. No declarar deploy exitoso ni recargar proxy." >&2
  exit 1
fi

echo "Recargando proxy global si existe..."
if docker ps --format '{{.Names}}' | grep -q '^fedes-proxy$'; then
  docker exec fedes-proxy nginx -s reload
fi

echo "Deploy completado. Verificar logs, healthchecks y matriz RLS antes de habilitar tráfico."
docker compose ps
docker compose logs backend --tail 30
