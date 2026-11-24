#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=scripts/lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

PR_PROJECT="maane-pr"
STATE_DIR="$CACHE_DIR/try-pr"
STATE_FILE="$STATE_DIR/state.env"
ADMIN_FILE="$STATE_DIR/admin.env"
COMPOSE_FILE="$STATE_DIR/compose.yml"
DATA_DIR="$STATE_DIR/data"
WORKTREE="$STATE_DIR/worktree"
LOCK_FILE="$CACHE_DIR/try-pr.lock"
DEFAULT_PORT=8096
PR="" COMMIT="" REF="" PORT="" IMAGE=""

usage() {
  cat <<EOF
Usage: scripts/try-pr.sh <command>

  <number>  Build the pull request's head in a disposable worktree as maane:pr-<number> and run it as the Compose
            project $PR_PROJECT with its own disposable PostgreSQL, secrets generated for it, and a first admin with
            a generated password and TOTP secret, on http://127.0.0.1:\${MAANE_PR_PORT:-$DEFAULT_PORT}.
  status    Show the pull request that runs, its health, and where its sign-in is.
  restore   Remove the pull request stack, its database, image, secrets, sign-in, and worktree.

One pull request at a time. The development stack (maane-dev), its data, and docker-compose-dev.yml are never
touched; nothing is pushed or merged, and your working tree is never changed.
State: $STATE_DIR
EOF
}

pr_compose() {
  docker compose -p "$PR_PROJECT" --project-directory "$STATE_DIR" -f "$COMPOSE_FILE" "$@"
}

take_lock() {
  command -v flock >/dev/null 2>&1 || die "flock (util-linux) is missing; install util-linux"
  mkdir -p "$CACHE_DIR"
  exec 9>"$LOCK_FILE"
  flock -n 9 || die "another scripts/try-pr.sh start or restore is running; wait for it to finish"
}

load_state() {
  [ -f "$STATE_FILE" ] || die "no pull request is running. Start one with: scripts/try-pr.sh <number>"
  # shellcheck source=/dev/null
  source "$STATE_FILE"
}

save_state() {
  {
    echo "PR=$PR"
    echo "COMMIT=$COMMIT"
    echo "REF=$REF"
    echo "PORT=$PORT"
    echo "IMAGE=$IMAGE"
  } >"$STATE_FILE"
}

write_compose() {
  sed -e "s|maane:\${MAANE_IMAGE_TAG}|$IMAGE|g" \
    -e "s|\./docker/|$WORKTREE/docker/|g" \
    -e "s|\${MAANE_DATA_DIR}|$DATA_DIR|g" \
    -e "s|\${MAANE_PUBLIC_URL}|http://127.0.0.1:$PORT|g" \
    -e "s|\${MAANE_PORT}|$PORT|g" \
    "$WORKTREE/docker/docker-compose-dev.example.yml" >"$COMPOSE_FILE"
  if grep -qF "\${MAANE_" "$COMPOSE_FILE"; then
    # A kept file with a ${VAR:?} form makes restore's Compose call fail, so restore never finishes.
    rm -f "$COMPOSE_FILE"
    die "the pull request's docker/docker-compose-dev.example.yml uses variables this script does not set (a pull request from before the plain \${VAR} form). Clean up with: scripts/try-pr.sh restore"
  fi
}

seed() {
  info "Creating the first admin through the setup screen's sign-up, with two-factor on"
  TOOLCHAIN_EXTRA_ARGS=(--network "${PR_PROJECT}_default" -v "$STATE_DIR:/state"
    -e MAANE_URL=http://server:8080 -e "MAANE_ORIGIN=http://127.0.0.1:$PORT" -e MAANE_ADMIN_FILE=/state/admin.env)
  in_toolchain "node scripts/lib/try-pr-seed.mjs"
  TOOLCHAIN_EXTRA_ARGS=()
  [ -f "$ADMIN_FILE" ] || die "the seed did not write $ADMIN_FILE"
  chmod 600 "$ADMIN_FILE"
}

try_pr() {
  local pr="$1" dev_port="${MAANE_PORT:-8095}"
  [[ "$pr" =~ ^[1-9][0-9]*$ ]] || die "pull request number expected, got: $pr"
  take_lock
  if [ -f "$STATE_FILE" ]; then
    load_state
    die "pull request #$PR is running. Remove it first: scripts/try-pr.sh restore"
  fi
  PORT="${MAANE_PR_PORT:-$DEFAULT_PORT}"
  if ! [[ "$PORT" =~ ^[1-9][0-9]{0,4}$ ]] || [ "$PORT" -gt 65535 ]; then
    die "MAANE_PR_PORT must be a port number"
  fi
  [ "$PORT" != "$dev_port" ] || die "port $PORT belongs to the development stack; set MAANE_PR_PORT to another port"
  require_linux_dir "$STATE_DIR"
  [ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$PR_PROJECT")" ] ||
    die "containers of $PR_PROJECT exist without a record in $STATE_DIR. Remove them: scripts/try-pr.sh restore"
  if [ -e "$WORKTREE" ] || [ -e "$DATA_DIR" ]; then
    die "leftovers of an earlier pull request are in $STATE_DIR. Remove them: scripts/try-pr.sh restore"
  fi

  PR="$pr" COMMIT="" REF="refs/maane/try-pr/$pr" IMAGE="maane:pr-$pr"
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"
  save_state

  info "Fetching pull request #$pr"
  # Without 9>&-, git maintenance left in the background keeps the lock, and restore is refused.
  git -C "$REPO_ROOT" fetch --quiet origin "+pull/$pr/head:$REF" 9>&- ||
    die "cannot fetch pull request #$pr from origin. Clean up with: scripts/try-pr.sh restore"
  COMMIT="$(git -C "$REPO_ROOT" rev-parse "$REF")"
  save_state
  git -C "$REPO_ROOT" worktree add --quiet --detach "$WORKTREE" "$COMMIT"

  info "Building $IMAGE from #$pr (${COMMIT:0:12})"
  docker build -f "$WORKTREE/docker/maane.Dockerfile" --build-arg "VERSION=pr$pr-${COMMIT:0:12}" -t "$IMAGE" "$WORKTREE" ||
    die "building $IMAGE failed. Clean up with: scripts/try-pr.sh restore"
  build_toolchain

  ensure_stack_env "$DATA_DIR"
  ensure_vapid_keys "$DATA_DIR" "$IMAGE"
  ensure_stack_dirs "$DATA_DIR"
  write_compose
  info "Starting the server of $PR_PROJECT on http://127.0.0.1:$PORT"
  pr_compose up -d --wait --wait-timeout 240 server || {
    pr_compose ps -a || true
    pr_compose logs --tail 50 || true
    die "the pull request's server did not become healthy. Clean up with: scripts/try-pr.sh restore"
  }
  seed || die "seeding failed; the stack still runs. Inspect it, then: scripts/try-pr.sh restore"
  info "Starting the rest of $PR_PROJECT"
  pr_compose up -d --wait --wait-timeout 600 || {
    pr_compose ps -a || true
    pr_compose logs --tail 50 || true
    die "the pull request stack did not become healthy. Clean up with: scripts/try-pr.sh restore"
  }
  check_stack

  info "Pull request #$pr (${COMMIT:0:12}) runs on http://127.0.0.1:$PORT"
  echo "    sign in with: $ADMIN_FILE (username, password, TOTP secret, backup codes)"
  echo "    when done: scripts/try-pr.sh restore"
}

status() {
  if [ ! -f "$STATE_FILE" ]; then
    info "No pull request is running"
    return 0
  fi
  load_state
  info "Pull request #$PR (${COMMIT:0:12}) as $PR_PROJECT on http://127.0.0.1:$PORT"
  echo "    worktree: $WORKTREE"
  echo "    sign-in:  $ADMIN_FILE"
  [ -f "$COMPOSE_FILE" ] || {
    echo "    the stack was not started"
    return 0
  }
  pr_compose ps
  local service cid health services
  services="$(pr_services)" || die "cannot read the services of $COMPOSE_FILE"
  for service in $services; do
    cid="$(pr_compose ps -q "$service")"
    [ -n "$cid" ] || die "service $service is not running"
    health="$(docker inspect -f '{{.State.Health.Status}}' "$cid")"
    echo "    $service health: $health"
    case "$service" in
      server | worker) [ "$(docker inspect -f '{{.Config.Image}}' "$cid")" = "$IMAGE" ] || die "$service does not run $IMAGE" ;;
    esac
    [ "$health" = healthy ] || die "$service is not healthy"
  done
  check_stack
}

pr_services() {
  pr_compose config --services
}

check_stack() {
  local services hardened
  services="$(pr_services)" || die "cannot read the services of $COMPOSE_FILE"
  hardened="$(grep -vx postgres <<<"$services")"
  # shellcheck disable=SC2086 # one name per word
  check_non_root "$PR_PROJECT" $services
  # shellcheck disable=SC2086
  check_hardening "$PR_PROJECT" $hardened
}

restore() {
  take_lock
  if [ -f "$STATE_FILE" ]; then
    load_state
    info "Removing pull request #$PR"
  else
    info "No pull request is recorded; removing any leftovers"
  fi
  require_linux_dir "$STATE_DIR"
  if [ -f "$COMPOSE_FILE" ]; then
    pr_compose down --remove-orphans
  elif [ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$PR_PROJECT")" ]; then
    docker compose -p "$PR_PROJECT" down --remove-orphans
  fi
  [ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$PR_PROJECT")" ] ||
    die "containers of $PR_PROJECT still exist"
  remove_data_dir "$DATA_DIR"
  if [ -n "$IMAGE" ] && docker image inspect "$IMAGE" >/dev/null 2>&1; then
    docker rmi "$IMAGE" >/dev/null
  fi
  if [ -e "$WORKTREE" ]; then
    git -C "$REPO_ROOT" worktree remove --force "$WORKTREE" 2>/dev/null || rm -rf "$WORKTREE"
  fi
  git -C "$REPO_ROOT" worktree prune
  if [ -n "$REF" ] && git -C "$REPO_ROOT" rev-parse -q --verify "$REF" >/dev/null; then
    git -C "$REPO_ROOT" update-ref -d "$REF"
  fi
  rm -f "$ADMIN_FILE" "$COMPOSE_FILE" "$STATE_FILE"
  rmdir "$STATE_DIR" 2>/dev/null || true
  if [ -n "$PR" ]; then
    info "Removed pull request #$PR: stack, database, image, secrets, sign-in, and worktree"
  else
    info "Nothing of a pull request stack is left"
  fi
}

main() {
  case "${1:-}" in
    -h | --help | help | "")
      usage
      return 0
      ;;
  esac
  [ $# -eq 1 ] || {
    usage
    die "one command expected"
  }
  require_docker
  case "$1" in
    status) status ;;
    restore) restore ;;
    *) try_pr "$1" ;;
  esac
}

main "$@"
