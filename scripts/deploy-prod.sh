#!/usr/bin/env bash
set -euo pipefail

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

# Compose reads .env independently; source it here for controlled role provisioning.
set -a
# shellcheck disable=SC1091
source .env
set +a

POSTGRES_DB="${POSTGRES_DB:-sedeagro}"
POSTGRES_USER="${POSTGRES_USER:-sedeagro}"
APP_DB_USER="${APP_DB_USER:-sedeagro_app}"

if [[ -z "${POSTGRES_PASSWORD:-}" || -z "${APP_DB_PASSWORD:-}" ]]; then
  echo "POSTGRES_PASSWORD y APP_DB_PASSWORD son obligatorios." >&2
  exit 1
fi
if [[ ! "$APP_DB_USER" =~ ^[a-z_][a-z0-9_]*$ || "$APP_DB_USER" == "$POSTGRES_USER" ]]; then
  echo "APP_DB_USER debe ser un rol propio, distinto del propietario de la BD." >&2
  exit 1
fi
if [[ ${#APP_DB_PASSWORD} -lt 24 || ! "$APP_DB_PASSWORD" =~ ^[A-Za-z0-9._~-]+$ ]]; then
  echo "APP_DB_PASSWORD debe tener 24+ caracteres y ser seguro para una URL PostgreSQL." >&2
  exit 1
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
docker compose run --rm --no-deps \
  -e MIGRATION_DB_USER="$POSTGRES_USER" \
  -e MIGRATION_DB_PASSWORD="$POSTGRES_PASSWORD" \
  -e MIGRATION_DB_NAME="$POSTGRES_DB" \
  backend sh -ec '
    DATABASE_URL="$(node -e '\''const p=process.env; const user=encodeURIComponent(p.MIGRATION_DB_USER); const pass=encodeURIComponent(p.MIGRATION_DB_PASSWORD); const db=encodeURIComponent(p.MIGRATION_DB_NAME); process.stdout.write("postgres://"+user+":"+pass+"@db:5432/"+db);'\'')" \
      npm run db:prepare
  '

echo "Provisionando permisos mínimos del usuario de la aplicación..."
docker compose exec -T db psql \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
  -v "db_owner=$POSTGRES_USER" \
  -v "app_user=$APP_DB_USER" \
  -v "app_password=$APP_DB_PASSWORD" \
  < scripts/provision-runtime-role.sql

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
