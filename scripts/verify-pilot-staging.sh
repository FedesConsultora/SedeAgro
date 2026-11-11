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
for command in curl git grep awk tr; do
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
# Require one non-ambiguous copy of every security header. Substring greps
# could accept CSP "script-src 'self' 'unsafe-inline'" or HSTS
# "max-age=86400garbage", and duplicated headers can be interpreted
# differently by clients and proxies.
if ! printf '%s\n' "$headers" | tr -d '\r' | awk '
function trim(s) {
  sub(/^[[:space:]]+/, "", s)
  sub(/[[:space:]]+$/, "", s)
  return s
}
{
  if ($0 ~ /^[[:space:]]/) bad = 1
  colon = index($0, ":")
  if (!colon) next
  name = tolower(trim(substr($0, 1, colon-1)))
  value = trim(substr($0, colon+1))
  if (name == "content-security-policy") { csp_count++; csp=value }
  else if (name == "strict-transport-security") { hsts_count++; hsts=value }
  else if (name == "referrer-policy") {
    referrer_count++; if (tolower(value) != "no-referrer") bad=1
  }
  else if (name == "x-frame-options") {
    frame_count++; if (tolower(value) != "deny") bad=1
  }
  else if (name == "x-content-type-options") {
    type_count++; if (tolower(value) != "nosniff") bad=1
  }
}
END {
  if (bad || csp_count != 1 || hsts_count != 1 ||
      referrer_count != 1 || frame_count != 1 || type_count != 1) exit 1
  # HSTS is scoped only to this staging hostname. Reject additional
  # directives, typos, duplicate max-age and overly large numeric values.
  if (tolower(hsts) !~ /^max-age=[0-9]+$/) exit 1
  age = substr(hsts, 9)
  if (length(age) > 9 || (age+0) < 86400) exit 1

  required["default-src"]="'\''self'\''"
  required["script-src"]="'\''self'\''"
  required["connect-src"]="'\''self'\''"
  required["worker-src"]="'\''self'\''"
  required["object-src"]="'\''none'\''"
  required["base-uri"]="'\''self'\''"
  required["form-action"]="'\''self'\''"
  required["frame-ancestors"]="'\''none'\''"
  n = split(csp, directives, ";")
  for (i=1; i<=n; i++) {
    directive = trim(directives[i])
    if (directive == "") continue
    split(directive, words, /[[:space:]]+/)
    key = tolower(words[1])
    value = trim(substr(directive, length(words[1])+1))
    if (key == "" || seen[key]++) exit 1
    if ((key in required) && value != required[key]) exit 1
  }
  for (key in required) if (!seen[key]) exit 1
}
'; then
  echo "BLOCKED: staging devolvió CSP, HSTS u otros headers inseguros o ambiguos." >&2
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
