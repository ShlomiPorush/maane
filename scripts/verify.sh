#!/usr/bin/env bash
# The single verification entry point, used locally and in CI.
# Usage: scripts/verify.sh [--changed [BASE]] [--guards-only]
set -euo pipefail

# shellcheck source=scripts/lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

CHANGED_BASE=""
CHECKS=1

usage() {
  cat <<'EOF'
Usage: scripts/verify.sh [options]

  (no options)      Full sweep: guards and their tests, then install from the lockfile, lint and format,
                    types, unit tests and builds of every package.
  --changed [BASE]  Compare with BASE (default origin/main). Guards only when every change is documentation;
                    only the changed packages and their dependents when every change is inside apps/ or
                    packages/; otherwise the full sweep.
  --guards-only     Only the repository guards and their tests.
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

MERGE_BASE=""
changed_files() {
  MERGE_BASE="$(git -C "$REPO_ROOT" merge-base "$CHANGED_BASE" HEAD)" || die "cannot find a merge base with $CHANGED_BASE"
  {
    git -C "$REPO_ROOT" diff --name-only "$MERGE_BASE"
    git -C "$REPO_ROOT" ls-files --others --exclude-standard
  } | sort -u
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
}

main() {
  require_docker
  build_toolchain

  local filter=""
  if [ -n "$CHANGED_BASE" ] && [ $CHECKS -eq 1 ]; then
    mapfile -t files < <(changed_files)
    if [ ${#files[@]} -eq 0 ]; then
      info "No changes since $CHANGED_BASE: guards only"
      CHECKS=0
    elif ! printf '%s\n' "${files[@]}" | grep -qvE '^(docs/|README\.md$|AGENTS\.md$|CHANGELOG\.md$|LICENSE$)'; then
      info "Documentation-only change: guards only"
      CHECKS=0
    elif ! printf '%s\n' "${files[@]}" | grep -qvE '^(apps|packages)/[^/]+/'; then
      # Root files (manifests, lockfile, tool configuration, scripts) reach every package: those run everything.
      filter="...[$MERGE_BASE]"
      info "Changes only inside packages: the changed packages and their dependents"
    fi
  fi

  run_guards
  if [ $CHECKS -eq 1 ]; then
    run_checks "$filter"
  fi
  info "Verify passed"
}

main
