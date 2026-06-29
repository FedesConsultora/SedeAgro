#!/usr/bin/env bash
set -euo pipefail

echo "====================================="
echo "  SedeAgro - Deploy Producción"
echo "====================================="
echo ""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

if [ ! -f "backend/.env" ]; then
  echo "Falta backend/.env. Crealo a partir de backend/.env.example antes de desplegar."
  exit 1
fi

if [ -z "${SKIP_GIT_PULL:-}" ]; then
  echo "Actualizando código desde main..."
  git pull origin main
fi

echo ""
echo "Reconstruyendo y levantando contenedores..."
docker compose up -d --build --remove-orphans

echo ""
echo "Esperando al backend para migraciones..."
sleep 8

if docker exec sedeagro_backend npm run db:prepare; then
  echo "Migraciones y datos base aplicados."
else
  echo "Falló la preparación de base de datos. Revisá logs antes de continuar."
  exit 1
fi

echo ""
echo "Refrescando proxy global si existe..."
if docker ps --format '{{.Names}}' | grep -q "^fedes-proxy$"; then
  docker exec fedes-proxy nginx -s reload
  echo "Proxy recargado."
else
  echo "No encontré fedes-proxy; omito reload."
fi

echo ""
echo "Deploy completo."
docker compose ps

echo ""
echo "Últimas líneas del backend:"
docker compose logs backend --tail 30
