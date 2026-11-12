#!/usr/bin/env bash
# Finds the CI result of a commit on main, for the Release workflow (.github/workflows/release.yml),
# so a release can reuse a green CI run of the commit instead of running the whole CI again.
# Usage: scripts/ci-result.sh --sha SHA (--wait | --expect-run ID)
set -euo pipefail

CI_WORKFLOW=".github/workflows/ci.yml"
WAIT_SECONDS="${CI_RESULT_WAIT_SECONDS:-1800}"
POLL_SECONDS="${CI_RESULT_POLL_SECONDS:-30}"
CALL_TIMEOUT="${CI_RESULT_CALL_TIMEOUT:-30}"
SHA=""
MODE=""
EXPECT_RUN=""

usage() {
  cat <<'EOF'
Usage: scripts/ci-result.sh --sha SHA (--wait | --expect-run ID)

  --sha SHA         The commit on main to find the CI result of.
  --wait            Find the newest CI run of the commit and, while it is queued or running, wait for
                    it: CI_RESULT_WAIT_SECONDS of elapsed time (1800 by default), looking again every
                    CI_RESULT_POLL_SECONDS (30 by default). Exits 0 with reuse=true only when it ended in
                    success, and 0 with reuse=false for anything else, including an API answer that
                    fails, takes longer than CI_RESULT_CALL_TIMEOUT seconds (30 by default) or is
                    unexpected.
  --expect-run ID   Check again, without waiting, that the newest CI run of the commit is still run
                    ID and that its latest attempt succeeded. Exits 0 if so and 1 otherwise.

The CI runs are those of the workflow file .github/workflows/ci.yml (by its workflow id) with this
head commit on main, started by push or workflow_dispatch; pull request runs and runs on other
branches never count. The newest one (created last) decides, by its current record, which is its
latest attempt: a newer run or attempt that failed, was cancelled or still runs wins over an older
green one. Prints reuse=, run_id= and reason= lines on stdout, for GITHUB_OUTPUT. Needs gh (GH_TOKEN,
GH_REPO), jq and timeout. Exits 2 on usage errors.
EOF
}

die_usage() {
  echo "ci-result: $*" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --sha)
      SHA="${2:-}"
      shift
      ;;
    --wait) MODE="wait" ;;
    --expect-run)
      MODE="expect"
      EXPECT_RUN="${2:-}"
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die_usage "unknown argument: $1" ;;
  esac
  shift
done

[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || die_usage "--sha needs a full commit SHA"
[ -n "$MODE" ] || die_usage "choose --wait or --expect-run ID"
[ "$MODE" != expect ] || [[ "$EXPECT_RUN" =~ ^[1-9][0-9]*$ ]] || die_usage "--expect-run needs a run id"
[[ "$WAIT_SECONDS" =~ ^[0-9]+$ ]] || die_usage "CI_RESULT_WAIT_SECONDS must be a whole number"
[[ "$POLL_SECONDS" =~ ^[1-9][0-9]*$ ]] || die_usage "CI_RESULT_POLL_SECONDS must be a positive whole number"
[[ "$CALL_TIMEOUT" =~ ^[1-9][0-9]*$ ]] || die_usage "CI_RESULT_CALL_TIMEOUT must be a positive whole number"
[[ "${GH_REPO:-}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die_usage "GH_REPO must be owner/repo"
for tool in gh jq timeout date; do
  command -v "$tool" >/dev/null || die_usage "$tool is not installed"
done

# Prints the result once, then exits: 0, except 1 when --expect-run did not find the run it expects.
finish() {
  local reuse="$1" run_id="$2" reason="$3"
  echo "ci-result: $reason" >&2
  printf 'reuse=%s\nrun_id=%s\nreason=%s\n' "$reuse" "$run_id" "$reason"
  if [ "$MODE" = expect ] && [ "$reuse" != true ]; then
    exit 1
  fi
  exit 0
}

# A GET of the GitHub API that fails when it takes longer than CALL_TIMEOUT seconds (killed 5 seconds
# later if it ignores the stop).
api() { timeout --kill-after=5 "$CALL_TIMEOUT" gh api "$1"; }

now() { date +%s; }

# The newest CI run of SHA on main, judged by its current record (its latest attempt). Sets RUN_ID
# (empty when there is none), RUN_ATTEMPT, RUN_STATE (success, failed or running) and RUN_DETAIL (the
# conclusion or the status) and returns 0, or sets REASON and returns 1 when an answer fails or is not
# what was expected. jq decides on the exact values; only numbers and fixed words leave it.
newest_run() {
  local json workflow_id newest state
  RUN_ID="" RUN_ATTEMPT="" RUN_STATE="" RUN_DETAIL="" REASON=""

  if ! json="$(api "repos/$GH_REPO/actions/workflows/ci.yml")" ||
    ! workflow_id="$(jq -er --arg path "$CI_WORKFLOW" '
      if .path == $path and (.id | type) == "number" and .id >= 1 and .id == (.id | floor)
      then .id else error("unexpected workflow") end' <<<"$json")"; then
    REASON="cannot read the CI workflow"
    return 1
  fi

  # One page holds every run of one commit on main; more than that is unexpected, not paginated.
  # The event filter takes one value only, so push and workflow_dispatch are selected here.
  if ! json="$(api "repos/$GH_REPO/actions/workflows/$workflow_id/runs?head_sha=$SHA&branch=main&exclude_pull_requests=true&per_page=100")" ||
    ! newest="$(jq -er --arg sha "$SHA" --argjson workflow "$workflow_id" '
      if (.total_count | type) != "number" or (.workflow_runs | type) != "array" then error("unexpected list")
      elif .total_count > (.workflow_runs | length) then error("more runs than one page")
      elif any(.workflow_runs[];
        (.id | type) != "number" or .id < 1 or .id != (.id | floor)
        or (.workflow_id | type) != "number" or (.head_sha | type) != "string"
        or (.event | type) != "string" or (.created_at | type) != "string"
        or ((.head_branch | type) != "string" and .head_branch != null))
      then error("unexpected run")
      else
        [.workflow_runs[] | select(.workflow_id == $workflow and .head_sha == $sha and .head_branch == "main"
          and (.event == "push" or .event == "workflow_dispatch"))]
        | sort_by(.created_at, .id) | last
        | if . == null then "none" else .id end
      end' <<<"$json")"; then
    REASON="cannot read the CI runs of $SHA"
    return 1
  fi
  [ "$newest" != none ] || return 0
  RUN_ID="$newest"

  # The run's current record holds its latest attempt, even one that started after the list was read.
  if ! json="$(api "repos/$GH_REPO/actions/runs/$RUN_ID")" ||
    ! state="$(jq -er --argjson id "$RUN_ID" --argjson workflow "$workflow_id" --arg sha "$SHA" '
      ["failure", "cancelled", "timed_out", "action_required", "neutral", "skipped", "stale", "startup_failure"] as $failed
      | ["queued", "in_progress", "waiting", "pending", "requested"] as $running
      | .status as $status | .conclusion as $conclusion
      | if .id != $id or .workflow_id != $workflow or .head_sha != $sha or .head_branch != "main"
          or (.event != "push" and .event != "workflow_dispatch")
          or (.run_attempt | type) != "number" or .run_attempt < 1 or .run_attempt != (.run_attempt | floor)
        then "invalid"
        elif $status == "completed" and $conclusion == "success" then "success \(.run_attempt) success"
        elif $status == "completed" and any($failed[]; . == $conclusion) then "failed \(.run_attempt) \($conclusion)"
        elif any($running[]; . == $status) then "running \(.run_attempt) \($status)"
        else "invalid" end' <<<"$json")"; then
    REASON="cannot read CI run $RUN_ID"
    return 1
  fi
  if [ "$state" = invalid ]; then
    REASON="CI run $RUN_ID of $SHA answered with unexpected values"
    return 1
  fi
  read -r RUN_STATE RUN_ATTEMPT RUN_DETAIL <<<"$state"
  return 0
}

describe() { echo "CI run $RUN_ID of $SHA (attempt $RUN_ATTEMPT)"; }

if [ "$MODE" = expect ]; then
  newest_run || finish false "" "$REASON"
  [ -n "$RUN_ID" ] || finish false "" "no CI run of $SHA on main any more"
  [ "$RUN_ID" = "$EXPECT_RUN" ] || finish false "$RUN_ID" "$(describe) is newer than the reused run $EXPECT_RUN"
  case "$RUN_STATE" in
    success) finish true "$RUN_ID" "$(describe) is still the newest and succeeded" ;;
    failed) finish false "$RUN_ID" "$(describe) ended with $RUN_DETAIL" ;;
    *) finish false "$RUN_ID" "$(describe) is $RUN_DETAIL" ;;
  esac
fi

# The wait ends by elapsed time, API calls included. Each round makes three calls of at most
# CALL_TIMEOUT + 5 seconds, and no sleep goes past the deadline, so the script ends at most
# 3 * (CALL_TIMEOUT + 5) seconds after it (105 seconds by default).
deadline=$(($(now) + WAIT_SECONDS))
while :; do
  # Each round selects again, so a newer run or a new attempt that started meanwhile decides.
  newest_run || finish false "" "$REASON"
  [ -n "$RUN_ID" ] || finish false "" "no CI run of $SHA on main"
  case "$RUN_STATE" in
    success) finish true "$RUN_ID" "$(describe) succeeded" ;;
    failed) finish false "$RUN_ID" "$(describe) ended with $RUN_DETAIL" ;;
    running)
      left=$((deadline - $(now)))
      [ $left -gt 0 ] || finish false "$RUN_ID" "$(describe) is still $RUN_DETAIL after ${WAIT_SECONDS}s"
      echo "ci-result: $(describe) is $RUN_DETAIL; waiting" >&2
      sleep $((left < POLL_SECONDS ? left : POLL_SECONDS))
      ;;
    *) finish false "$RUN_ID" "$(describe) gave no usable result" ;;
  esac
done
