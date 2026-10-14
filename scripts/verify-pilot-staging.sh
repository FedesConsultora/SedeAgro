#!/usr/bin/env bash
set -euo pipefail

# Read-only staging verification. Never reads JWTs, posts fixtures, migrates the
# database, clears Redis, or modifies a deployment.
if [[ $# -ne 2 ]]; then
  echo "Uso: $0 https://staging.example.test HEAD_SHA" >&2
  exit 2
fi
URL="${1%/}"
EXPECTED_SHA="$2"
if [[ ! "$URL" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{2,5})?$ ]]; then
  echo "Se requiere una URL HTTPS absoluta sin ruta, query ni credenciales." >&2
  exit 2
fi
if [[ ! "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "El HEAD esperado debe ser un SHA Git completo de 40 caracteres." >&2
  exit 2
fi
for command in curl git grep; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Falta herramienta: $command" >&2
    exit 2
  fi
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ACTUAL_SHA="$(git -C "$ROOT" rev-parse HEAD)"
if [[ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]]; then
  echo "El checkout local no coincide con el SHA esperado: $ACTUAL_SHA" >&2
  exit 1
fi

request_status() {
  curl --silent --show-error --max-time 15 \
    --output /dev/null --write-out '%{http_code}' "$1"
}
echo "Validando encabezados TLS y salud de staging (sin escritura)..."
headers="$(curl --silent --show-error --max-time 15 --head "$URL/")"
printf '%s\n' "$headers" | grep -Eiq '^content-security-policy:.*script-src .self.'
printf '%s\n' "$headers" | grep -Eiq '^referrer-policy: no-referrer'
printf '%s\n' "$headers" | grep -Eiq '^x-frame-options: DENY'
printf '%s\n' "$headers" | grep -Eiq '^x-content-type-options: nosniff'
if [[ "$(request_status "$URL/health")" != "200" ]]; then
  echo "Falla healthcheck público de staging." >&2
  exit 1
fi
if [[ "$(request_status "$URL/api/v1/auth/me")" != "401" ]]; then
  echo "Una solicitud sin JWT debe devolver 401, no datos privados." >&2
  exit 1
fi
echo "PASS staging read-only: HTTPS, CSP, anti-framing, health 200 y acceso anónimo 401."
echo "ATENCIÓN: este script NO certifica RLS, restores, apps móviles ni el commit desplegado."
echo "El SHA verificado corresponde al checkout local: $ACTUAL_SHA"
