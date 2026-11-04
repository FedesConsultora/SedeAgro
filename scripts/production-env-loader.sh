#!/usr/bin/env bash
# Trusted, in-process parser for ONLY the five production database values.
# Unlike "source .env", assignments, shell substitutions and arbitrary dotenv
# keys are never evaluated as Bash code. Do not print or export passwords here.
# Sourced from reviewed main by deploy-prod.sh; not a CLI.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  printf 'BLOCKED: production environment loader is not a standalone command.\n' >&2
  exit 2
fi

production_read_env_value() {
  [[ $# -eq 2 && "$2" =~ ^[A-Z][A-Z0-9_]*$ ]] || return 2
  local file="$1" key="$2" line matches=0
  REPLY=''
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "$key="* ]]; then
      (( matches += 1 ))
      REPLY="${line#*=}"
    fi
  done < "$file"
  [[ "$matches" -eq 1 && -n "$REPLY" &&
     "$REPLY" != *$'\r'* && "$REPLY" != *$'\n'* ]]
}

production_load_db_env() {
  [[ $# -eq 1 && $- != *x* && -f "$1" && ! -L "$1" && -r "$1" ]] || return 2
  local file="$1" bytes
  bytes="$(wc -c < "$file")" || return 2
  [[ "$bytes" =~ ^[0-9]+$ && "$bytes" -gt 0 && "$bytes" -le 65536 ]] || return 2

  local db owner owner_password app app_password value
  production_read_env_value "$file" POSTGRES_DB || return 2
  db="$REPLY"
  production_read_env_value "$file" POSTGRES_USER || return 2
  owner="$REPLY"
  production_read_env_value "$file" POSTGRES_PASSWORD || return 2
  owner_password="$REPLY"
  production_read_env_value "$file" APP_DB_USER || return 2
  app="$REPLY"
  production_read_env_value "$file" APP_DB_PASSWORD || return 2
  app_password="$REPLY"
  REPLY=''

  [[ "$db" =~ ^[a-z_][a-z0-9_]*$ && ${#db} -le 63 &&
     "$owner" =~ ^[a-z_][a-z0-9_]*$ && ${#owner} -le 63 &&
     "$app" =~ ^[a-z_][a-z0-9_]*$ && ${#app} -le 63 &&
     "$app" != "$owner" ]] || return 2
  for value in "$owner_password" "$app_password"; do
    [[ ${#value} -ge 24 && "$value" =~ ^[A-Za-z0-9._~-]+$ ]] || return 2
    case "${value,,}" in
      *replace*|*change*|*demo*|*example*|*password*|*secret*|*test*) return 2 ;;
    esac
  done
  # Global assignments intentional: never use eval or echo the credentials.
  POSTGRES_DB="$db"
  POSTGRES_USER="$owner"
  POSTGRES_PASSWORD="$owner_password"
  APP_DB_USER="$app"
  APP_DB_PASSWORD="$app_password"
  return 0
}
