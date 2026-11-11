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

# Never inherit ~/.curlrc credentials, ambient HTTPS proxies or a redirect.
# A staging acceptance must contact the exact requested HTTPS origin.
curl_safe() {
  curl -q --silent --show-error --max-time 15 --connect-timeout 5 \
    --proto '=https' --noproxy '*' "$@"
}
request_status() {
  curl_safe --output /dev/null --write-out '%{http_code}' "$1"
}
echo "Validando encabezados TLS y salud de staging (sin escritura)..."
if ! headers="$(curl_safe --head "$URL/")"; then
  echo "BLOCKED: no se pudieron verificar los encabezados HTTPS de staging." >&2
  exit 1
fi
# A proxy CONNECT, redirect or stale/non-200 shell must not be mistaken for
# the HTTPS response of the staging frontend itself.
http_status_lines="$(printf '%s\n' "$headers" | grep -Ec '^HTTP/[0-9.]+[[:space:]]+[0-9]{3}([[:space:]]|$)' || true)"
if [[ "$http_status_lines" != "1" ]] ||
    ! printf '%s\n' "$headers" | grep -Eq '^HTTP/(1\.[01]|2|3)[[:space:]]+200([[:space:]]|$)'; then
  echo "BLOCKED: staging no devolvió un único HTTP 200 HTTPS sin redirecciones." >&2
  exit 1
fi
printf '%s\n' "$headers" | grep -Eiq '^content-security-policy:.*script-src .self.'
printf '%s\n' "$headers" | grep -Eiq '^referrer-policy: no-referrer'
printf '%s\n' "$headers" | grep -Eiq '^x-frame-options: DENY'
printf '%s\n' "$headers" | grep -Eiq '^x-content-type-options: nosniff'
# HSTS is provided by the HTTPS edge. Require at least 24 hours for pilot;
# never accept a header on HTTP or silently treat liveness as DB readiness.
hsts="$(printf '%s\n' "$headers" | tr -d '\r' | grep -Ei '^strict-transport-security:' | head -n 1 || true)"
if [[ ! "$hsts" =~ [Mm][Aa][Xx]-[Aa][Gg][Ee]=([0-9]+) ]]; then
  echo "Falta Strict-Transport-Security con max-age en el edge HTTPS." >&2
  exit 1
fi
if (( ${BASH_REMATCH[1]} < 86400 )); then
  echo "Strict-Transport-Security max-age inferior al mínimo piloto (86400s)." >&2
  exit 1
fi
if [[ "$(request_status "$URL/health")" != "200" ]] ||
    ! health_body="$(curl_safe --fail "$URL/health")" ||
    [[ "$health_body" != '{"ok":true,"service":"sedeagro-backend"}' ]]; then
  echo "BLOCKED: /health no corresponde a la API real de SedeAgro." >&2
  exit 1
fi
if [[ "$(request_status "$URL/health/ready")" != "200" ]] ||
    ! ready_body="$(curl_safe --fail "$URL/health/ready")" ||
    [[ "$ready_body" != '{"ready":true}' ]]; then
  echo "BLOCKED: /health/ready no confirma conexión real con PostgreSQL." >&2
  exit 1
fi
# Match the SHA baked into the backend image actually serving HTTPS.
# A successful local checkout and matching SPA bytes alone are insufficient.
if ! served_revision="$(curl_safe --fail "$URL/health/revision")"; then
  echo "No se pudo validar revision del backend servido por staging." >&2
  exit 1
fi
if [[ "$served_revision" != "{\"revision\":\"$EXPECTED_SHA\"}" ]]; then
  echo "BLOCKED: backend de staging sirve un SHA distinto o sin proveniencia." >&2
  exit 1
fi
if [[ "$(request_status "$URL/api/v1/auth/me")" != "401" ]]; then
  echo "Una solicitud sin JWT debe devolver 401, no datos privados." >&2
  exit 1
fi
echo "PASS staging read-only: HTTPS 200 sin redirecciones, HSTS, CSP, JSON de health/readiness, backend SHA exacto y acceso anónimo 401."
echo "ATENCIÓN: verifica el SHA declarado por la imagen backend, no los digests OCI ni RLS, restores o QA móvil."
echo "El SHA verificado corresponde al checkout local: $ACTUAL_SHA"
