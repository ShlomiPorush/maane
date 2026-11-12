# Shared helpers for the workflow scripts. Source it; do not execute it.
# shellcheck shell=bash

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export REPO_ROOT

TOOLCHAIN_IMAGE="maane-toolchain:local"
POSTGRES_IMAGE="postgres:18.6-bookworm"
export POSTGRES_IMAGE
# Keep its version equal to @playwright/test in e2e/package.json: scripts/verify.sh refuses a mismatch.
PLAYWRIGHT_IMAGE="mcr.microsoft.com/playwright:v1.64.1-noble"
export PLAYWRIGHT_IMAGE
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/maane"

die() {
  echo "error: $*" >&2
  exit 1
}

info() {
  echo "==> $*"
}

require_docker() {
  command -v docker >/dev/null 2>&1 || die "docker is not available. Run this inside WSL with Docker running."
  docker info >/dev/null 2>&1 || die "docker is installed but not reachable. Start Docker and try again."
}

# Builds the toolchain image (cached by Docker when nothing changed).
build_toolchain() {
  require_docker
  docker build --quiet -f "$REPO_ROOT/docker/toolchain.Dockerfile" -t "$TOOLCHAIN_IMAGE" "$REPO_ROOT/docker" >/dev/null ||
    die "building the toolchain image failed"
}

# Runs a command inside the toolchain container with the repository mounted at /repo.
in_toolchain() {
  mkdir -p "$CACHE_DIR/pnpm-store"
  local tty=()
  [ -t 1 ] && tty=(-t)
  docker run --rm "${tty[@]}" \
    --user "$(id -u):$(id -g)" \
    -v "$REPO_ROOT:/repo" \
    -v "$CACHE_DIR/pnpm-store:/pnpm-store" \
    -e npm_config_store_dir=/pnpm-store \
    -e CI="${CI:-}" \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "${TOOLCHAIN_EXTRA_ARGS[@]}" \
    "$TOOLCHAIN_IMAGE" bash -c "$*"
}
TOOLCHAIN_EXTRA_ARGS=()

# 32 bytes from the kernel's cryptographically secure generator, as hex.
random_hex() {
  od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
}

# Installs dependencies from the lockfile.
install_deps() {
  in_toolchain "pnpm install --frozen-lockfile --reporter=append-only"
}

# Builds the Maane image (server, worker, and web UI in one) with the given tag.
build_image() {
  local tag="$1" version="${2:-$1}"
  require_docker
  info "Building maane:$tag"
  docker build -f "$REPO_ROOT/docker/maane.Dockerfile" --build-arg "VERSION=$version" -t "maane:$tag" "$REPO_ROOT" ||
    die "building maane:$tag failed"
}

# Fails when any process of a running Compose service runs as UID 0.
check_non_root() {
  local project="$1" service cid uids
  shift
  for service in "$@"; do
    cid="$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$service")"
    [ -n "$cid" ] || die "service $service is not running"
    uids="$(docker top "$cid" -o pid,uid | awk 'NR > 1 { print $2 }' | sort -u | tr '\n' ' ')"
    [ -n "$uids" ] || die "service $service has no process"
    if grep -qw 0 <<<"$uids"; then
      die "service $service runs a process as root (UIDs: $uids)"
    fi
    echo "    $service runs as UID ${uids% }"
  done
}

# Fails unless each named service holds no capability, cannot gain privileges, and has a read-only root.
check_hardening() {
  local project="$1" service cid
  shift
  for service in "$@"; do
    cid="$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$service")"
    [ -n "$cid" ] || die "service $service is not running"
    [ "$(docker inspect -f '{{json .HostConfig.CapDrop}} {{json .HostConfig.CapAdd}}' "$cid")" = '["ALL"] null' ] ||
      die "$service holds capabilities"
    [ "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$cid")" = true ] || die "$service has a writable root file system"
    docker inspect -f '{{range .HostConfig.SecurityOpt}}{{println .}}{{end}}' "$cid" | grep -qxE 'no-new-privileges(:true)?' ||
      die "$service may gain new privileges"
    echo "    $service holds no capabilities, read-only root, no new privileges"
  done
}

# Refuses a data directory on the Windows file system: development and test data live on Linux.
require_linux_dir() {
  local resolved
  resolved="$(realpath -m "$1")"
  case "$resolved" in
    /mnt/*) die "$resolved is on the Windows file system; set MAANE_DATA_DIR to a Linux path" ;;
  esac
}

# Refuses a data directory inside the repository: a stack's database and keys must never be committable.
require_outside_repo() {
  local resolved
  resolved="$(realpath -m "$1")"
  case "$resolved/" in
    "$REPO_ROOT"/*) die "$resolved is inside the repository; set MAANE_DATA_DIR to a path outside it" ;;
  esac
}

# Removes a project-owned data directory. PostgreSQL's files belong to its own UID, so the contents are deleted
# from a throwaway container.
remove_data_dir() {
  local dir="$1"
  [ -d "$dir" ] || return 0
  build_toolchain
  docker run --rm --user 0 -v "$dir:/target" "$TOOLCHAIN_IMAGE" bash -c 'shopt -s dotglob; rm -rf /target/*' ||
    die "could not empty $dir"
  rmdir "$dir"
}

# --- Stack secrets ---
# A development or verification stack's database password and keys are generated on this machine into two owner-only
# files next to the database they open: postgres.env (only what PostgreSQL needs) and app.env (what the server and
# the worker need). The repository holds none of them.
POSTGRES_ENV_NAMES=(POSTGRES_USER POSTGRES_DB POSTGRES_PASSWORD)
APP_ENV_NAMES=(DATABASE_URL MAANE_AUTH_SECRETS MAANE_SETTINGS_KEYS)

# A regular file, mode 600, with a non-empty value for every name given.
env_file_valid() {
  local file="$1" name
  shift
  if [ ! -f "$file" ] || [ -L "$file" ]; then return 1; fi
  [ "$(stat -c %a "$file")" = 600 ] || return 1
  for name in "$@"; do
    grep -qE "^$name=.+" "$file" || return 1
  done
}

# Creates postgres.env and app.env once, before PostgreSQL first starts, and never rewrites them. A database without
# its files is refused: new values would not open it.
ensure_stack_env() {
  local dir="$1" contents password tmp lock has_postgres=0 has_app=0
  require_linux_dir "$dir"
  require_outside_repo "$dir"
  mkdir -p "$dir/postgres"
  chmod 700 "$dir"
  # One run at a time checks and publishes the pair. The kernel releases the lock however a run ends, so a run that
  # holds it and finds only one of the files knows that the start which wrote it has stopped.
  exec {lock}>"$dir/.secrets.lock" || die "cannot open the lock in $dir"
  flock "$lock" || die "cannot lock $dir"
  if [ ! -e "$dir/postgres.env" ] && [ ! -e "$dir/app.env" ]; then
    contents="$(ls -A "$dir/postgres")" || die "cannot read $dir/postgres; no secrets were created"
    [ -z "$contents" ] || die "$dir/postgres holds a database, but its password and keys are missing.
  Restore postgres.env and app.env, or start over with: scripts/local.sh nuke"
    password="$(random_hex)"
    tmp="$(mktemp -d "$dir/.env.XXXXXX")"
    (
      umask 077
      printf 'POSTGRES_USER=maane\nPOSTGRES_DB=maane\nPOSTGRES_PASSWORD=%s\n' "$password" >"$tmp/postgres.env"
      printf 'DATABASE_URL=postgres://maane:%s@postgres:5432/maane\nMAANE_AUTH_SECRETS=1:%s\nMAANE_SETTINGS_KEYS=1:%s\n' \
        "$password" "$(random_hex)" "$(random_hex)" >"$tmp/app.env"
    )
    # ln never replaces a file, also not one another tool put there meanwhile.
    if ln "$tmp/postgres.env" "$dir/postgres.env" 2>/dev/null; then
      ln "$tmp/app.env" "$dir/app.env" 2>/dev/null || true
    fi
    rm -r -f -- "$tmp"
  fi
  [ -e "$dir/postgres.env" ] && has_postgres=1
  [ -e "$dir/app.env" ] && has_app=1
  if [ "$has_postgres" != "$has_app" ]; then
    contents="$(ls -A "$dir/postgres")" || die "cannot read $dir/postgres"
    [ -n "$contents" ] ||
      die "$dir holds only one of postgres.env and app.env, and no database yet: an earlier start stopped half way.
  Delete the file that is there, then start again"
    die "$dir holds a database but only one of postgres.env and app.env. Restore the missing file; new values would not open the database"
  fi
  env_file_valid "$dir/postgres.env" "${POSTGRES_ENV_NAMES[@]}" ||
    die "$dir/postgres.env is missing, incomplete, or not mode 600. Restore it; new values would not open the database"
  env_file_valid "$dir/app.env" "${APP_ENV_NAMES[@]}" ||
    die "$dir/app.env is missing, incomplete, or not mode 600. Restore it; new keys would not read the stored secrets"
  exec {lock}>&-
}

# --- Data and signature directories ---
# Next to the database, a stack has DIR/data, the attachments the server and the worker share (owned by UID 1000, the
# image's node user), and DIR/clamav, ClamAV's signatures (owned by UID 100, the clamav user). Both are created by a
# root container, because the host user is not always UID 1000 (a CI runner is not) and can never be UID 100.
FILES_OWNER="1000:1000"
CLAMAV_OWNER="100:101"
# Signatures kept between stacks, so freshclam does not download them for every verification run. Stacks never mount
# it: each copies it in and out under CLAMAV_CACHE_LOCK, so runs in several checkouts at once do not mix their files.
CLAMAV_CACHE="$CACHE_DIR/clamav"
CLAMAV_CACHE_LOCK="$CACHE_DIR/clamav.lock"

# Creates DIR/data and DIR/clamav when missing, and gives them their owners. An empty signature directory is filled
# from the cache when the cache holds signatures; otherwise ClamAV downloads them on its first start.
ensure_stack_dirs() {
  local dir="$1" lock
  require_linux_dir "$dir"
  require_outside_repo "$dir"
  build_toolchain
  mkdir -p "$CLAMAV_CACHE"
  exec {lock}>"$CLAMAV_CACHE_LOCK" || die "cannot open $CLAMAV_CACHE_LOCK"
  flock "$lock" || die "cannot lock $CLAMAV_CACHE_LOCK"
  # shellcheck disable=SC2016 # expands inside the container
  docker run --rm --user 0 -v "$dir:/stack" -v "$CLAMAV_CACHE:/cache:ro" "$TOOLCHAIN_IMAGE" bash -c '
    set -euo pipefail
    install -d -o "${0%:*}" -g "${0#*:}" -m 750 /stack/data
    install -d -o "${1%:*}" -g "${1#*:}" -m 755 /stack/clamav
    if [ ! -e /stack/clamav/main.cvd ] && [ ! -e /stack/clamav/main.cld ] && [ -e /cache/main.cvd ]; then
      cp -- /cache/*.cvd /cache/*.sign /stack/clamav/ 2>/dev/null || true
      cp -- /cache/*.cld /stack/clamav/ 2>/dev/null || true
      chown -R "$1" /stack/clamav
      echo "    signatures copied from the cache"
    fi' "$FILES_OWNER" "$CLAMAV_OWNER" || die "cannot prepare the data and signature directories in $dir"
  exec {lock}>&-
}

# Replaces the signature cache with the signatures of a running or stopped stack, as one swap of directories under
# the lock, so a run that copies from the cache meanwhile never sees half of an update.
save_clamav_cache() {
  local dir="$1" lock
  [ -e "$dir/clamav/main.cvd" ] || [ -e "$dir/clamav/main.cld" ] || return 0
  mkdir -p "$CLAMAV_CACHE"
  exec {lock}>"$CLAMAV_CACHE_LOCK" || die "cannot open $CLAMAV_CACHE_LOCK"
  flock "$lock" || die "cannot lock $CLAMAV_CACHE_LOCK"
  # shellcheck disable=SC2016 # expands inside the container
  docker run --rm --user 0 -v "$dir/clamav:/stack:ro" -v "$CACHE_DIR:/caches" "$TOOLCHAIN_IMAGE" bash -c '
    set -euo pipefail
    shopt -s nullglob
    rm -rf /caches/clamav.new /caches/clamav.old
    mkdir /caches/clamav.new
    files=(/stack/*.cvd /stack/*.cld /stack/*.sign)
    [ ${#files[@]} -eq 0 ] || cp -- "${files[@]}" /caches/clamav.new/
    chown -R "$0" /caches/clamav.new
    chmod 755 /caches/clamav.new
    mv /caches/clamav /caches/clamav.old
    mv /caches/clamav.new /caches/clamav
    rm -rf /caches/clamav.old' "$(id -u):$(id -g)" || echo "warning: could not save the ClamAV signatures to $CLAMAV_CACHE" >&2
  exec {lock}>&-
}

# --- Development stack ---
DEV_PROJECT="maane-dev"
DEV_COMPOSE_FILE="$REPO_ROOT/docker-compose-dev.yml"
DEV_DEFAULT_DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/maane-dev"

# Runs Compose on the developer's copy of the development template. MAANE_PORT and MAANE_PUBLIC_URL may come from
# the shell; nothing else does.
dev_compose() {
  [ -f "$DEV_COMPOSE_FILE" ] || die "docker-compose-dev.yml is missing. Create it with:
  cp docker/docker-compose-dev.example.yml docker-compose-dev.yml"
  local data_dir="${MAANE_DATA_DIR:-$DEV_DEFAULT_DATA_DIR}"
  env -u COMPOSE_ENV_FILES MAANE_DATA_DIR="$data_dir" MAANE_IMAGE_TAG=dev \
    docker compose --env-file /dev/null -p "$DEV_PROJECT" --project-directory "$REPO_ROOT" -f "$DEV_COMPOSE_FILE" "$@"
}
