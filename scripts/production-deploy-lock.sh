#!/usr/bin/env bash
# 0P.38 — Source into deploy-prod.sh at process entry. Linux host-wide,
# nonblocking advisory lock; the open FD stays alive until the deploy exits.
# NEVER unlink the lock file: replacement creates an independent inode/lock.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  printf 'BLOCKED production deployment lock: must be sourced by the entrypoint\n' >&2
  exit 2
fi

sedeagro_acquire_production_deploy_lock() {
  local dir="${1:-}" file mode fd before after executable previous_umask
  if [[ $# -ne 1 || "$dir" != /* || "$dir" == / ||
        "$dir" == *'/../'* || "$dir" == *'/./'* ||
        "$dir" == *'//'* || "$dir" == */ ]]; then
    printf 'BLOCKED production deployment lock: invalid absolute lock namespace\n' >&2
    return 2
  fi
  for executable in flock stat mkdir; do
    if ! command -v "$executable" >/dev/null 2>&1; then
      printf 'BLOCKED production deployment lock: required Linux lock utility missing\n' >&2
      return 2
    fi
  done
  # This is a fixed host namespace in the production caller, not a repo or
  # worktree-local file. A distinct operator UID cannot borrow its lock.
  previous_umask="$(umask)"
  umask 077
  if [[ ! -e "$dir" && ! -L "$dir" ]]; then
    mkdir -m 700 -- "$dir" 2>/dev/null || true
  fi
  if [[ ! -d "$dir" || -L "$dir" || ! -O "$dir" ]]; then
    printf 'BLOCKED production deployment lock: unsafe or unavailable directory\n' >&2
    return 2
  fi
  mode="$(stat -c %a -- "$dir")" || return 2
  if [[ ! "$mode" =~ ^[0-7]{3,4}$ ]] || (( (8#$mode & 077) != 0 )); then
    printf 'BLOCKED production deployment lock: directory is not private\n' >&2
    return 2
  fi
  file="$dir/production-deploy.lock"
  if [[ -e "$file" || -L "$file" ]]; then
    if [[ -L "$file" || ! -f "$file" || ! -O "$file" ]] ||
       [[ "$(stat -c %h -- "$file")" != 1 ]]; then
      printf 'BLOCKED production deployment lock: unsafe existing lock inode\n' >&2
      return 2
    fi
    mode="$(stat -c %a -- "$file")" || return 2
    if [[ ! "$mode" =~ ^[0-7]{3,4}$ ]] || (( (8#$mode & 077) != 0 )); then
      printf 'BLOCKED production deployment lock: existing file is not private\n' >&2
      return 2
    fi
  fi
  # Only the process owning the 0700 namespace can create/replace entries.
  # Verify the opened descriptor still refers to that same regular inode.
  if ! exec {SEDEAGRO_PROD_DEPLOY_LOCK_FD}>"$file"; then
    printf 'BLOCKED production deployment lock: cannot open lock file\n' >&2
    return 2
  fi
  fd="$SEDEAGRO_PROD_DEPLOY_LOCK_FD"
  if [[ -L "$file" || ! -f "$file" || ! -O "$file" ]] ||
     [[ "$(stat -c %h -- "$file")" != 1 ]]; then
    printf 'BLOCKED production deployment lock: unsafe opened inode\n' >&2
    return 2
  fi
  mode="$(stat -c %a -- "$file")" || return 2
  before="$(stat -c '%d:%i' -- "$file")" || return 2
  after="$(stat -Lc '%d:%i' -- "/proc/self/fd/$fd")" || return 2
  if [[ ! "$mode" =~ ^[0-7]{3,4}$ ]] ||
     (( (8#$mode & 077) != 0 )) || [[ "$before" != "$after" ]]; then
    printf 'BLOCKED production deployment lock: descriptor or permissions changed\n' >&2
    return 2
  fi
  if ! flock -n "$fd"; then
    printf 'BLOCKED production deployment lock: another release is in progress\n' >&2
    return 2
  fi
  # Restore the invoking shell's original defaults for git/Docker/other work.
  umask "$previous_umask"
}
sedeagro_acquire_production_deploy_lock "$@"
