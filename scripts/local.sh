#!/usr/bin/env bash
# Development stack: build the image, start, stop, inspect, and reset.
# Usage: scripts/local.sh <build|up|start|down|status|logs|nuke>
set -euo pipefail

# shellcheck source=scripts/lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

PROJECT="$DEV_PROJECT"
export MAANE_DATA_DIR="${MAANE_DATA_DIR:-$DEV_DEFAULT_DATA_DIR}"
SERVICES=(server worker postgres clamav)
# The services that run with no capability, no new privileges, and a read-only root.
HARDENED_SERVICES=(server worker clamav)

usage() {
  cat <<EOF
Usage: scripts/local.sh <command>

  build    Build the maane:dev image.
  up       Build, then start the stack in the foreground.
  start    Build, then start the stack in the background and verify it.
  down     Stop the stack. The database in \$MAANE_DATA_DIR is kept.
  status   Show containers, health, runtime users, and hardening.
  logs     Follow the logs.
  nuke     Stop the stack and delete its data directory (asks first).

Data directory: $MAANE_DATA_DIR (the database, postgres.env and app.env with its generated password and keys,
data/ with the attachments, and clamav/ with ClamAV's signatures)
The shell may set MAANE_PORT (default 8095) and MAANE_PUBLIC_URL.
EOF
}

build() {
  build_image dev "dev-$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo local)"
}

status() {
  dev_compose ps
  check_non_root "$PROJECT" "${SERVICES[@]}"
  check_hardening "$PROJECT" "${HARDENED_SERVICES[@]}"
}

nuke() {
  local resolved answer
  resolved="$(realpath -m "$MAANE_DATA_DIR")"
  case "$resolved" in
    "" | / | "$HOME" | "$REPO_ROOT") die "refusing to delete $resolved" ;;
  esac
  [[ "$(basename "$resolved")" == maane-dev* ]] || die "refusing to delete $resolved: the name must start with maane-dev"
  require_linux_dir "$resolved"
  read -r -p "Delete the development stack and ALL data in $resolved? Type 'nuke' to confirm: " answer || answer=""
  [ "$answer" = "nuke" ] || die "cancelled; nothing was deleted"
  dev_compose down --remove-orphans
  remove_data_dir "$resolved"
  info "Deleted $resolved"
}

main() {
  local cmd="${1:-}"
  case "$cmd" in
    build)
      build
      ;;
    up)
      ensure_stack_env "$MAANE_DATA_DIR"
      ensure_stack_dirs "$MAANE_DATA_DIR"
      build
      dev_compose up --remove-orphans
      ;;
    start)
      ensure_stack_env "$MAANE_DATA_DIR"
      ensure_stack_dirs "$MAANE_DATA_DIR"
      build
      # The server first: its setup screen is open for 5 minutes from its start while no user exists, and ClamAV's
      # first signature download can take longer than that.
      info "Starting the server of $PROJECT"
      dev_compose up -d --remove-orphans --wait --wait-timeout 180 server || {
        dev_compose ps
        die "the server did not become healthy; see: scripts/local.sh logs"
      }
      info "Server ready: http://$(dev_compose port server 8080) (the setup screen is open for 5 minutes while no user exists)"
      info "Starting the rest of $PROJECT"
      # ClamAV loads its signatures before it turns healthy, and downloads them first on the first start.
      dev_compose up -d --remove-orphans --wait --wait-timeout 600 || {
        dev_compose ps
        die "the stack did not become healthy; see: scripts/local.sh logs"
      }
      status
      info "Ready: http://$(dev_compose port server 8080)"
      ;;
    down)
      dev_compose down --remove-orphans
      ;;
    status)
      status
      ;;
    logs)
      dev_compose logs -f
      ;;
    nuke)
      nuke
      ;;
    -h | --help | help | "")
      usage
      ;;
    *)
      usage
      die "unknown command: $cmd"
      ;;
  esac
}

require_docker
main "$@"
