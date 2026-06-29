#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

cleanup() {
  echo ""
  echo "Deteniendo el entorno de SedeAgro..."
  [ -n "${BACKEND_LOG_PID:-}" ] && kill "$BACKEND_LOG_PID" 2>/dev/null || true
  docker compose -f docker-compose.dev.yml down 2>/dev/null || true
  echo "Entorno detenido."
  exit
}

trap cleanup SIGINT EXIT

echo "Limpiando procesos previos..."
docker compose -f docker-compose.dev.yml down --remove-orphans
docker rm -f sedeagro_backend_dev sedeagro_frontend_dev 2>/dev/null || true

echo "Iniciando base de datos, Redis y backend en Docker..."
docker compose -f docker-compose.dev.yml up -d --build sedeagro-db sedeagro-redis backend

echo "Esperando al backend..."
sleep 6

echo "Aplicando migraciones y datos base..."
docker exec sedeagro_backend_dev npm run db:prepare

echo "Siguiendo logs del backend..."
docker logs -f sedeagro_backend_dev &
BACKEND_LOG_PID=$!

echo "Iniciando frontend React..."
if ! command -v npm >/dev/null 2>&1; then
  [ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"
  [ -s "/usr/local/opt/nvm/nvm.sh" ] && . "/usr/local/opt/nvm/nvm.sh"
fi

if command -v npm >/dev/null 2>&1; then
  cd frontend
  npm install --silent
  npm run dev -- --port 3000
else
  echo "npm no está disponible localmente; usando frontend en Docker."
  docker compose -f docker-compose.dev.yml up -d frontend
  docker logs -f sedeagro_frontend_dev
fi
