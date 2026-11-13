#!/usr/bin/env bash
# The single verification entry point, used locally and in CI.
# Usage: scripts/verify.sh [--changed [BASE]] [--guards-only] [--skip-integration] [--only checks|integration|e2e]
set -euo pipefail

# shellcheck source=scripts/lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

CHANGED_BASE=""
MERGE_BASE=""
CHANGED=""
CHECKS=1
INTEGRATION=1
ONLY=""

usage() {
  cat <<'EOF'
Usage: scripts/verify.sh [options]

  (no options)      Full sweep: guards and their tests, then install from the lockfile, lint and format,
                    types, unit tests and builds of every package, the integration tests, and the container
                    stack with the end-to-end tests.
  --changed [BASE]  Compare with BASE (default origin/main). Guards only when every change is documentation;
                    only the changed packages and their dependents when every change is inside apps/ or
                    packages/; otherwise the full sweep.
  --guards-only     Only the repository guards and their tests.
  --skip-integration  Skip the integration tests against a disposable PostgreSQL, the container stack checks, and
                    the end-to-end tests.
  --only STAGE      One stage while working on it, without the guards: checks (install, lint, types, unit tests,
                    builds, schema), integration (install, then the integration tests), or e2e (install, then the
                    image, the stack checks, and the end-to-end tests). Not a substitute for the full sweep.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --changed)
      CHANGED_BASE="origin/main"
      if [ $# -gt 1 ] && [[ "$2" != --* ]]; then
        CHANGED_BASE="$2"
        shift
      fi
      ;;
    --guards-only) CHECKS=0 ;;
    --skip-integration) INTEGRATION=0 ;;
    --only)
      ONLY="${2:-}"
      [[ "$ONLY" =~ ^(checks|integration|e2e)$ ]] || die "--only needs checks, integration, or e2e"
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage
      die "unknown option: $1"
      ;;
  esac
  shift
done

# The files changed since MERGE_BASE, committed or not, and new files that are not ignored. Runs in the main
# shell (never in a pipe or a process substitution), so a failing git stops verify instead of looking like
# "no changes".
changed_files() {
  local committed untracked
  # --no-renames lists both sides of a move, so moving code into docs/ is never a documentation-only change.
  committed="$(git -C "$REPO_ROOT" diff --name-only --no-renames "$MERGE_BASE")" ||
    die "git diff against $CHANGED_BASE failed"
  untracked="$(git -C "$REPO_ROOT" ls-files --others --exclude-standard)" || die "git ls-files failed"
  CHANGED="$(printf '%s\n%s\n' "$committed" "$untracked" | sed '/^$/d' | sort -u)"
}

run_guards() {
  info "Guards"
  in_toolchain "bash scripts/lib/guards.sh" || die "guards failed"
  info "Guard tests: each violation planted in a scratch repository"
  in_toolchain "bash scripts/lib/test-guards.sh" || die "guard tests failed"
}

# Runs lint, types, unit tests and builds. FILTER selects packages ("" for all).
run_checks() {
  local filter="$1" selector=""
  [ -n "$filter" ] && selector="--filter '$filter'"
  info "Install from the lockfile"
  install_deps
  info "Lint and format"
  in_toolchain "pnpm lint"
  info "Types, unit tests and builds${filter:+ ($filter)}"
  in_toolchain "pnpm -r $selector run typecheck && pnpm -r $selector run test && pnpm -r $selector --if-present run build"
  info "Database schema matches its migrations"
  # A schema change without its migration would otherwise show only when the next migration is generated. The
  # generator runs on a copy of the migrations, so a missing migration fails here without writing into the checkout.
  # shellcheck disable=SC2016 # expands inside the container
  # drizzle-kit prefixes "./" to --out, so the copy is named relative to apps/server.
  in_toolchain 'copy="$(mktemp -d)" && cp -r apps/server/drizzle "$copy/drizzle" && cd apps/server &&
    out="$(pnpm exec drizzle-kit generate --dialect postgresql --schema ./src/db/schema.ts \
      --out "$(realpath --relative-to=. "$copy/drizzle")" --name schema-check 2>&1)"; rm -r -f -- "$copy";
    echo "$out" | tail -1; grep -q "No schema changes" <<<"$out"' ||
    die "apps/server/src/db/schema.ts has changes without a migration; run: pnpm --filter @maane/server db:generate --name <change>"
}

# Integration tests against a disposable PostgreSQL on a private Docker network. Its password is new for every run,
# kept in an owner-only file in a temporary directory, and passed to containers only through --env-file.
VERIFY_DIR=""
VERIFY_NETWORK=""
cleanup_integration() {
  if [ -n "$VERIFY_NETWORK" ]; then
    docker rm -f "$VERIFY_NETWORK-postgres" >/dev/null 2>&1 || true
    docker network rm "$VERIFY_NETWORK" >/dev/null 2>&1 || true
  fi
  [ -n "$VERIFY_DIR" ] && rm -rf "$VERIFY_DIR"
  VERIFY_DIR=""
  VERIFY_NETWORK=""
}

run_integration() {
  local filter="$1" selector="" password
  [ -n "$filter" ] && selector="--filter '$filter'"
  VERIFY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/maane-verify.XXXXXX")"
  VERIFY_NETWORK="maane-verify-$$"
  trap cleanup_integration EXIT
  chmod 700 "$VERIFY_DIR"
  password="$(random_hex)"
  (
    umask 077
    printf 'POSTGRES_USER=maane\nPOSTGRES_DB=maane\nPOSTGRES_PASSWORD=%s\n' "$password" >"$VERIFY_DIR/postgres.env"
    printf 'MAANE_TEST_DATABASE_URL=postgres://maane:%s@postgres:5432/maane\n' "$password" >"$VERIFY_DIR/test.env"
  )

  info "Integration: disposable PostgreSQL ($POSTGRES_IMAGE)"
  docker network create "$VERIFY_NETWORK" >/dev/null || die "could not create the verification network"
  docker run -d --name "$VERIFY_NETWORK-postgres" --network "$VERIFY_NETWORK" --network-alias postgres \
    --env-file "$VERIFY_DIR/postgres.env" --tmpfs /var/lib/postgresql "$POSTGRES_IMAGE" >/dev/null ||
    die "could not start PostgreSQL"
  local tries=0
  until docker exec "$VERIFY_NETWORK-postgres" pg_isready -U maane -d maane -h 127.0.0.1 >/dev/null 2>&1; do
    tries=$((tries + 1))
    [ "$tries" -lt 60 ] || die "PostgreSQL did not become ready"
    sleep 1
  done
  TOOLCHAIN_EXTRA_ARGS=(--network "$VERIFY_NETWORK" --env-file "$VERIFY_DIR/test.env")
  in_toolchain "pnpm -r $selector --if-present run test:integration" || die "integration tests failed"
  TOOLCHAIN_EXTRA_ARGS=()
  cleanup_integration
  trap - EXIT
}

# The production Compose file, with its three files filled in with values new for this check: it must be valid, show
# no secret in `docker compose config --no-env-resolution` (secrets come only through env_file), and give PostgreSQL
# only its own variables. Runs in a subshell, so the caller removes the directory whatever happens.
production_compose_checks() {
  local dir="$1" password auth keys names
  password="$(random_hex)" auth="$(random_hex)" keys="$(random_hex)"
  cp "$REPO_ROOT/docker-compose.yml" "$dir/docker-compose.yml"
  (
    umask 077
    printf 'VERSION=0.0.0\nDOMAIN=maane.example.com\n' >"$dir/.env"
    printf 'POSTGRES_USER=maane\nPOSTGRES_DB=maane\nPOSTGRES_PASSWORD=%s\n' "$password" >"$dir/postgres.env"
    printf 'DATABASE_URL=postgres://maane:%s@postgres:5432/maane\nMAANE_AUTH_SECRETS=1:%s\nMAANE_SETTINGS_KEYS=1:%s\n' \
      "$password" "$auth" "$keys" >"$dir/app.env"
  )
  production() {
    env -u COMPOSE_ENV_FILES -u COMPOSE_FILE -u COMPOSE_PROJECT_NAME \
      docker compose --project-directory "$dir" -f "$dir/docker-compose.yml" "$@"
  }
  production config --quiet || die "docker-compose.yml is not valid with its .env, postgres.env, and app.env"
  # Never printed: the output holds this check's values when the file is wrong.
  production config --no-env-resolution >"$dir/unresolved.yml" || die "docker compose config failed"
  if grep -qF -e "$password" -e "$auth" -e "$keys" "$dir/unresolved.yml"; then
    die "docker compose config --no-env-resolution shows a secret: docker-compose.yml interpolates one or sets it under environment:"
  fi
  production config --format json >"$dir/resolved.json" || die "docker compose config failed"
  TOOLCHAIN_EXTRA_ARGS=(-v "$dir:/production:ro")
  names="$(in_toolchain 'jq -r ".services.postgres.environment | keys | join(\" \")" /production/resolved.json')" ||
    die "cannot read the postgres service's environment"
  TOOLCHAIN_EXTRA_ARGS=()
  [ "$names" = "POSTGRES_DB POSTGRES_PASSWORD POSTGRES_USER" ] ||
    die "the production postgres service gets more than its own variables: $names"
  echo "    docker-compose.yml: valid, secrets only through env_file, postgres gets only POSTGRES_*"
}

check_production_compose() {
  local dir status=0
  info "Production Compose file"
  dir="$(mktemp -d "${TMPDIR:-/tmp}/maane-verify-production.XXXXXX")"
  chmod 700 "$dir"
  (production_compose_checks "$dir") || status=$?
  rm -r -f -- "$dir"
  [ "$status" -eq 0 ] || exit "$status"
}

# The container stack: the image built from this checkout, started from the tracked development template with a data
# directory and secrets new for this run, then health, readiness, runtime users, and hardening are checked, and the
# worker's file service and intake run against the real ClamAV. The project and the image tag belong to this run alone, so a
# verify running in another checkout cannot replace the image under it. ClamAV's signatures come from the cache
# (ensure_stack_dirs) and go back to it once the stack ran, so freshclam downloads only what changed.
RUN_ID="$$-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
STACK_PROJECT="maane-verify-stack-$RUN_ID"
STACK_TAG="verify-$RUN_ID"
STACK_DIR=""
# The container of the sending worker (start_sender), while it runs.
SENDER=""
stack() {
  env -u COMPOSE_ENV_FILES MAANE_DATA_DIR="$STACK_DIR" MAANE_IMAGE_TAG="$STACK_TAG" MAANE_PORT=0 \
    MAANE_PUBLIC_URL=http://127.0.0.1:8095 \
    docker compose --env-file /dev/null -p "$STACK_PROJECT" --project-directory "$REPO_ROOT" \
    -f "$REPO_ROOT/docker/docker-compose-dev.example.yml" "$@"
}

# Stops the stack, then removes its data directory and image, but only once Docker confirms that no container of the
# project is left: data a running container still uses is kept and reported instead.
cleanup_stack() {
  local left
  [ -z "$SENDER" ] || docker rm -f "$SENDER" >/dev/null 2>&1 || true
  [ -z "$STACK_DIR" ] || stack down --remove-orphans >/dev/null 2>&1 || true
  if ! left="$(docker ps -aq --filter "label=com.docker.compose.project=$STACK_PROJECT")" || [ -n "$left" ]; then
    echo "error: $STACK_PROJECT did not stop, so its data (${STACK_DIR:-none}) and maane:$STACK_TAG were kept." >&2
    echo "  Stop it with: docker compose -p $STACK_PROJECT down, then remove them." >&2
    return 1
  fi
  if [ -n "$STACK_DIR" ]; then
    remove_data_dir "$STACK_DIR"
    STACK_DIR=""
  fi
  if docker image inspect "maane:$STACK_TAG" >/dev/null 2>&1; then
    docker image rm "maane:$STACK_TAG" >/dev/null || echo "warning: could not remove maane:$STACK_TAG" >&2
  fi
}

# The file checks of the stack, as the worker runs them: apps/worker/src/testing/stack-check.ts, bundled here and run
# in a container of the worker service (its user, networks, read-only root, and /data), never shipped in the image.
run_file_checks() {
  local out sha stored
  info "Files: the worker's scanner and store against the real ClamAV ($STACK_PROJECT)"
  in_toolchain "pnpm --filter @maane/worker run build:stack-check" >/dev/null || die "building the stack check failed"
  local check=(stack run --rm --no-deps -T -v "$REPO_ROOT/apps/worker/dist/stack-check:/check:ro" worker)
  out="$("${check[@]}" node /check/stack-check.js 2>&1)" || {
    echo "$out"
    fail_stack "the file checks failed"
  }
  echo "$out" | grep -v '^stored '
  sha="$(sed -n 's/^stored //p' <<<"$out")"
  [[ "$sha" =~ ^[0-9a-f]{64}$ ]] || fail_stack "the file checks stored no file"
  info "Files: the server reads what the worker stored, after both containers are recreated"
  stack up -d --no-deps --force-recreate --wait --wait-timeout 240 server worker || fail_stack "server and worker did not come back"
  stored="$(stack exec -T server sha256sum "/data/files/${sha:0:2}/$sha")" || fail_stack "the server cannot read /data/files/${sha:0:2}/$sha"
  [ "${stored%% *}" = "$sha" ] || fail_stack "the file the server reads differs from the one the worker stored"
  echo "    /data/files/${sha:0:2}/$sha: the same content in the recreated server"
}

# Intake end to end, as the worker runs it: apps/worker/src/testing/stack-intake.ts (bundled by run_file_checks) in a
# container of the worker service, against the stack's database and the real ClamAV, with a stand-in Graph inside
# that container. Runs before the end-to-end tests, which read the tickets it makes (e2e/tickets.spec.ts): messages
# become tickets of two organizations in live mode and intake records in listening mode; the check leaves the intake
# mode listening, no source current, and no default address.
run_intake_checks() {
  local out
  info "Intake: stand-in Graph to tickets and listening records, with the real ClamAV ($STACK_PROJECT)"
  local check=(stack run --rm --no-deps -T -v "$REPO_ROOT/apps/worker/dist/stack-check:/check:ro" worker)
  out="$("${check[@]}" node /check/stack-intake.js 2>&1)" || {
    echo "$out"
    fail_stack "the intake checks failed"
  }
  echo "$out"
}

# The worker that sends the end-to-end tests' replies: apps/worker/src/testing/stack-worker.ts (bundled by
# run_file_checks), the worker as index.ts starts it, in a container of the worker service, with two stand-in SMTP
# servers inside that container (their certificates trusted there only, their credentials generated for the run). The
# stack's own worker stops meanwhile, so only this one takes the queue's jobs, and nothing reaches a real server.
start_sender() {
  info "Sending: the worker with stand-in SMTP servers in its own process ($STACK_PROJECT)"
  stack stop worker >/dev/null 2>&1 || fail_stack "the stack's worker did not stop"
  SENDER="$STACK_PROJECT-sender"
  stack run -d --name "$SENDER" --no-deps -v "$REPO_ROOT/apps/worker/dist/stack-check:/check:ro" worker node /check/stack-worker.js >/dev/null || fail_stack "the sending worker did not start"
  for _ in $(seq 90); do
    if docker logs "$SENDER" 2>&1 | grep -qx 'stack worker ready'; then
      echo "    the sending worker is ready"
      return 0
    fi
    sleep 1
  done
  docker logs "$SENDER" 2>&1 | tail -20
  fail_stack "the sending worker did not get ready"
}

# What the stand-ins received while the end-to-end tests ran: the Hebrew reply with an English paragraph and an
# attachment (e2e/replies.spec.ts) reached SMTP2GO's stand-in, with the reference line and the ticket number.
check_sends() {
  local out line
  docker stop -t 30 "$SENDER" >/dev/null 2>&1 || true
  out="$(docker logs "$SENDER" 2>&1 | grep '^received ' || true)"
  docker rm -f "$SENDER" >/dev/null 2>&1 || true
  SENDER=""
  while IFS= read -r line; do echo "    $line"; done <<<"$out"
  grep -qE '^received smtp2go .* hebrew=yes english=yes attachments=1 reference=yes subject-number=yes dropped=no$' <<<"$out" ||
    die "the stand-in SMTP2GO did not receive the Hebrew reply of the end-to-end tests"
}

fail_stack() {
  stack ps -a || true
  stack logs --tail 60 || true
  die "$1"
}

# Runs e2e/ in the Playwright image on the stack's network. e2e/global-setup.ts forwards 127.0.0.1:8095, the stack's
# MAANE_PUBLIC_URL, to the server, so the server's Origin checks see its own address.
run_e2e() {
  local pinned
  pinned="$(sed -nE 's|.*"@playwright/test": "([^"]+)".*|\1|p' "$REPO_ROOT/e2e/package.json")"
  [ "v$pinned-noble" = "${PLAYWRIGHT_IMAGE##*:}" ] ||
    die "@playwright/test $pinned does not match $PLAYWRIGHT_IMAGE; keep both on one version"
  docker run --rm --ipc=host --network "${STACK_PROJECT}_default" \
    --user "$(id -u):$(id -g)" -e HOME=/tmp -e CI="${CI:-}" -e E2E_TARGET=server:8080 \
    -v "$REPO_ROOT:/repo" -w /repo/e2e "$PLAYWRIGHT_IMAGE" \
    npx --no-install playwright test
}

run_stack() {
  check_production_compose
  # Set before the build, so an image built by a run that stops early is removed too.
  trap cleanup_stack EXIT
  build_image "$STACK_TAG" "verify-$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo local)"
  STACK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/maane-verify-stack.XXXXXX")"
  ensure_stack_env "$STACK_DIR"
  ensure_stack_dirs "$STACK_DIR"

  info "Container stack: health, readiness, runtime users, and hardening ($STACK_PROJECT)"
  # ClamAV loads its signatures before it turns healthy, and downloads them first when the cache was empty.
  stack up -d --remove-orphans --wait --wait-timeout 600 || fail_stack "the stack did not become healthy"
  TOOLCHAIN_EXTRA_ARGS=(--network "${STACK_PROJECT}_default")
  # shellcheck disable=SC2016 # expands inside the container
  in_toolchain 'body="$(curl -fsS http://server:8080/healthz/ready)" && echo "    /healthz/ready: $body" &&
    grep -q "\"database\":\"ok\"" <<<"$body"' || fail_stack "/healthz/ready does not report the database"
  TOOLCHAIN_EXTRA_ARGS=()
  check_non_root "$STACK_PROJECT" server worker postgres clamav
  check_hardening "$STACK_PROJECT" server worker clamav
  save_clamav_cache "$STACK_DIR"
  run_file_checks

  run_intake_checks

  start_sender
  info "End-to-end: the web UI against the stack (Playwright, $PLAYWRIGHT_IMAGE)"
  run_e2e || fail_stack "end-to-end tests failed"
  info "Sending: what the stand-in SMTP servers received"
  check_sends

  info "Stopping $STACK_PROJECT"
  trap - EXIT
  cleanup_stack || die "the verification stack did not stop"
}

main() {
  require_docker
  build_toolchain

  if [ -n "$ONLY" ]; then
    if [ -n "$CHANGED_BASE" ] || [ $CHECKS -eq 0 ] || [ $INTEGRATION -eq 0 ]; then
      die "--only runs one stage and takes no other option"
    fi
    case "$ONLY" in
      checks) run_checks "" ;;
      integration)
        info "Install from the lockfile"
        install_deps
        run_integration ""
        ;;
      e2e)
        info "Install from the lockfile"
        install_deps
        run_stack
        ;;
    esac
    info "Stage $ONLY passed (not the full sweep)"
    return
  fi

  local filter=""
  if [ -n "$CHANGED_BASE" ] && [ $CHECKS -eq 1 ]; then
    MERGE_BASE="$(git -C "$REPO_ROOT" merge-base "$CHANGED_BASE" HEAD)" ||
      die "cannot find a merge base with $CHANGED_BASE (a shallow clone needs fetch-depth: 0)"
    [[ "$MERGE_BASE" =~ ^[0-9a-f]{40}$ ]] || die "git merge-base gave no commit for $CHANGED_BASE"
    changed_files
    if [ -z "$CHANGED" ]; then
      info "No changes since $CHANGED_BASE: guards only"
      CHECKS=0
    elif ! grep -qvE '^(docs/|README\.md$|AGENTS\.md$|CHANGELOG\.md$|LICENSE$)' <<<"$CHANGED"; then
      info "Documentation-only change: guards only"
      CHECKS=0
    elif ! grep -qvE '^(apps|packages)/[^/]+/' <<<"$CHANGED"; then
      # Root files (manifests, lockfile, tool configuration, scripts) reach every package: those run everything.
      # pnpm's documented filter: the packages changed since the commit, and every package that depends on them.
      filter="...[$MERGE_BASE]"
      info "Changes only inside packages: the changed packages and their dependents"
    fi
  fi

  run_guards
  if [ $CHECKS -eq 1 ]; then
    run_checks "$filter"
    if [ $INTEGRATION -eq 1 ]; then
      run_integration "$filter"
      run_stack
    fi
  fi
  info "Verify passed"
}

main
