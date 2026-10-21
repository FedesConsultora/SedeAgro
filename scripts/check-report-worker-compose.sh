#!/usr/bin/env bash
set -euo pipefail

# Host-side opt-in health and restart inspection. Read-only: NEVER docker up,
# restart, exec, migrate, source .env or echo Compose config (contains secrets).
fail() { printf 'CRITICAL report-worker: %s\n' "$1" >&2; exit 2; }
[[ $# -eq 0 ]] || fail 'no arguments supported'
SHA="${SEDEAGRO_RELEASE_SHA:-}"
TENANT="${REPORT_WORKER_TENANT_ID:-}"
[[ "$SHA" =~ ^[a-f0-9]{40}$ ]] || fail 'expected full release SHA'
[[ "$TENANT" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$ ]] ||
  fail 'expected canonical tenant UUID'
[[ "${SEDEAGRO_REPORT_WORKER_APPROVAL:-}" == "START_REPORT_WORKER:$SHA:$TENANT" ]] ||
  fail 'approval does not match SHA and tenant'
command -v docker >/dev/null 2>&1 || fail 'Docker unavailable'
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -f "$ROOT/docker-compose.report-worker.yml" ]] || fail 'opt-in worker manifest missing'
cd "$ROOT"
# docker compose only resolves the container ID. STDERR may echo configuration
# internals on errors; never persist or forward that output into public logs.
cid="$(docker compose -f docker-compose.yml -f docker-compose.report-worker.yml \
  --profile reports ps -q report-worker 2>/dev/null)" || fail 'Compose lookup failed'
[[ "$cid" =~ ^[a-f0-9]{12,64}$ ]] || fail 'worker container missing or ambiguous'
state="$(docker inspect --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}|{{.RestartCount}}|{{index .Config.Labels "org.opencontainers.image.revision"}}' "$cid" 2>/dev/null)" ||
  fail 'unable to inspect report worker'
IFS='|' read -r status health restarts revision <<< "$state"
[[ "$revision" == "$SHA" ]] || fail 'container is not the approved release SHA'
[[ "$status" == 'running' ]] || fail 'worker is not running'
[[ "$health" == 'healthy' ]] || fail 'worker healthcheck is not healthy'
[[ "$restarts" =~ ^[0-9]{1,7}$ ]] || fail 'invalid restart counter'
(( 10#$restarts < 3 )) || fail 'repeated container restarts (at least 3)'
if (( 10#$restarts > 0 )); then
  printf 'WARNING report-worker: runtime healthy but previous restarts detected (%s)\n' "$restarts" >&2
  exit 1
fi
printf 'PASS report-worker: running, DB healthcheck healthy, zero restarts, approved SHA\n'
