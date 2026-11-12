#!/usr/bin/env bash
# Tests for scripts/ci-result.sh, with gh replaced by a stand-in that serves canned GitHub API answers
# (one after the other when a test gives several), fails, is slow or hangs on request, and date and
# sleep by a fake clock that only sleep and slow calls move. Covers which CI run decides, waiting for
# it, and the final check before a release. Run with the guards (scripts/lib/guards.sh).
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/maane-ci-result-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
SHA="1111111111111111111111111111111111111111"
OTHER_SHA="2222222222222222222222222222222222222222"
WORKFLOW_ID=383774817
FAILED=0
PASSED=0

check() {
  local what="$1"
  shift
  if "$@"; then
    PASSED=$((PASSED + 1))
  else
    FAILED=$((FAILED + 1))
    echo "FAIL: $what"
    [ -f "$WORK/case/out" ] && sed 's/^/      | /' "$WORK/case/out" "$WORK/case/err"
  fi
}

# --- stand-ins -------------------------------------------------------------------------------

mkdir -p "$WORK/bin"
cat >"$WORK/bin/gh" <<'EOF'
#!/usr/bin/env bash
# GitHub API stand-in: answers from $STATE/api/<key>.<n> for the n-th call of that key, else
# $STATE/api/<key>, else 404. MOCK_GH_SLOW=S moves the clock S seconds per call; MOCK_GH_HANG=KEY
# answers that key only after 30 real seconds.
echo "gh $*" >>"$STATE/calls"
[ "$1" = api ] && [ $# -eq 2 ] || { echo "unexpected gh $*" >&2; exit 2; }
[ -n "${MOCK_GH_DOWN:-}" ] && { echo "HTTP 502: Bad Gateway" >&2; exit 1; }
case "$2" in
  repos/owner/repo/actions/workflows/ci.yml) key=workflow ;;
  "repos/owner/repo/actions/workflows/$WORKFLOW_ID/runs?head_sha=$SHA&branch=main&"*) key=runs ;;
  repos/owner/repo/actions/runs/*) key="run.${2#repos/owner/repo/actions/runs/}" ;;
  *) echo "unexpected gh api $2" >&2; exit 2 ;;
esac
[ -n "${MOCK_GH_SLOW:-}" ] && echo $(($(cat "$STATE/clock") + MOCK_GH_SLOW)) >"$STATE/clock"
# A hung call answers as usual after 30 seconds, so only the time limit makes it fail.
[ "${MOCK_GH_HANG:-}" = "$key" ] && PATH=/usr/bin:/bin sleep 30 </dev/null >/dev/null 2>&1
n=$(($(cat "$STATE/count.$key" 2>/dev/null || echo 0) + 1))
echo "$n" >"$STATE/count.$key"
for f in "$STATE/api/$key.$n" "$STATE/api/$key"; do
  [ -f "$f" ] && { cat "$f"; exit 0; }
done
echo "gh: Not Found (HTTP 404)" >&2
exit 1
EOF
cat >"$WORK/bin/sleep" <<'EOF'
#!/usr/bin/env bash
echo "sleep $*" >>"$STATE/sleeps"
echo $(($(cat "$STATE/clock") + $1)) >"$STATE/clock"
EOF
cat >"$WORK/bin/date" <<'EOF'
#!/usr/bin/env bash
[ "$*" = +%s ] || { echo "unexpected date $*" >&2; exit 2; }
cat "$STATE/clock"
EOF
chmod +x "$WORK/bin/gh" "$WORK/bin/sleep" "$WORK/bin/date"
export WORKFLOW_ID SHA

# --- canned answers --------------------------------------------------------------------------

# A fresh case: the CI workflow, no runs yet, the clock at a fixed time.
sandbox() {
  rm -rf "$WORK/case"
  mkdir -p "$WORK/case/api"
  export STATE="$WORK/case"
  : >"$STATE/calls"
  echo 1000000 >"$STATE/clock"
  printf '{"id":%s,"name":"CI","path":".github/workflows/ci.yml","state":"active"}' "$WORKFLOW_ID" >"$STATE/api/workflow"
  runs
}

# A run as the list shows it: run ID ATTEMPT CREATED [EVENT] [BRANCH] [SHA]. Its status and conclusion
# here are those the list had when it was read; the run's record decides.
run() {
  printf '{"id":%s,"workflow_id":%s,"path":".github/workflows/ci.yml","head_sha":"%s","head_branch":"%s","event":"%s","run_attempt":%s,"status":"completed","conclusion":"success","created_at":"%s"}' \
    "$1" "$WORKFLOW_ID" "${6:-$SHA}" "${5:-main}" "${4:-push}" "$2" "$3"
}

# The runs list (the n-th answer with RUNS_CALL=n): runs RUN_JSON...
runs() {
  local IFS=,
  printf '{"total_count":%s,"workflow_runs":[%s]}' "$#" "$*" >"$STATE/api/runs${RUNS_CALL:+.$RUNS_CALL}"
}

# A run's current record (the n-th answer with CALL=n): record ID ATTEMPT STATUS [CONCLUSION], where
# CONCLUSION is the inside of a JSON string; REC_ID, REC_EVENT, REC_BRANCH and REC_SHA change a field.
record() {
  local conclusion="null"
  [ -n "${4:-}" ] && conclusion="\"$4\""
  printf '{"id":%s,"workflow_id":%s,"path":".github/workflows/ci.yml","head_sha":"%s","head_branch":"%s","event":"%s","run_attempt":%s,"status":"%s","conclusion":%s,"created_at":"%s"}' \
    "${REC_ID:-$1}" "$WORKFLOW_ID" "${REC_SHA:-$SHA}" "${REC_BRANCH:-main}" "${REC_EVENT:-push}" "$2" "$3" "$conclusion" "$T1" \
    >"$STATE/api/run.$1${CALL:+.$CALL}"
}

T1="2026-11-01T10:00:00Z"
T2="2026-11-01T11:00:00Z"
T3="2026-11-01T12:00:00Z"

# Runs the script: ci_result MODE_ARGS...; sets RC. WAIT, POLL and CALL_TIMEOUT set its limits.
ci_result() {
  (PATH="$WORK/bin:$PATH" GH_REPO=owner/repo CI_RESULT_WAIT_SECONDS="${WAIT:-3}" CI_RESULT_POLL_SECONDS="${POLL:-1}" \
    CI_RESULT_CALL_TIMEOUT="${CALL_TIMEOUT:-5}" bash "$REPO/scripts/ci-result.sh" --sha "$SHA" "$@") \
    >"$WORK/case/out" 2>"$WORK/case/err"
  RC=$?
}

result() { [ "$(cat "$WORK/case/out")" = "$(printf 'reuse=%s\nrun_id=%s\nreason=%s' "$1" "$2" "$3")" ]; }
reuses() { [ $RC -eq 0 ] && grep -qx "reuse=true" "$WORK/case/out" && grep -qx "run_id=$1" "$WORK/case/out"; }
declines() { [ $RC -eq 0 ] && grep -qx "reuse=false" "$WORK/case/out"; }
said() { grep -q "$1" "$WORK/case/out"; }
waited() {
  local n=0
  [ -f "$STATE/sleeps" ] && n="$(wc -l <"$STATE/sleeps")"
  [ "$n" -eq "$1" ]
}
slept() { [ -f "$STATE/sleeps" ] && [ "$(tr '\n' ' ' <"$STATE/sleeps")" = "$1" ]; }

# --- selection -------------------------------------------------------------------------------

sandbox
ci_result --wait
check "no run: no reuse" declines
check "  and says why" said "reason=no CI run of $SHA on main"
check "  without waiting" waited 0

sandbox
runs "$(run 100 1 "$T1")"
record 100 1 completed success
ci_result --wait
check "one green push run: reuse it" reuses 100
check "  with the whole result on stdout" result true 100 "CI run 100 of $SHA (attempt 1) succeeded"
check "  and the request filters by commit and main" grep -q "runs?head_sha=$SHA&branch=main&" "$STATE/calls"
check "  and reads the run's current record" grep -qx "gh api repos/owner/repo/actions/runs/100" "$STATE/calls"

sandbox
runs "$(run 100 1 "$T1" workflow_dispatch)"
REC_EVENT=workflow_dispatch record 100 1 completed success
ci_result --wait
check "a green manual run on main: reuse it" reuses 100

sandbox
runs "$(run 100 1 "$T1")" "$(run 101 1 "$T2")"
record 100 1 completed success
record 101 1 completed failure
ci_result --wait
check "green older and newer failed: no reuse" declines
check "  and names the newer run" said "reason=CI run 101 of $SHA (attempt 1) ended with failure"

sandbox
runs "$(run 101 1 "$T2")" "$(run 100 1 "$T1")"
record 100 1 completed success
record 101 1 completed cancelled
ci_result --wait
check "newer cancelled, listed first: no reuse" declines

sandbox
runs "$(run 100 1 "$T1")" "$(run 101 1 "$T2")"
record 100 1 completed success
CALL=1 record 101 1 in_progress
CALL=2 record 101 1 queued
CALL=3 record 101 1 completed success
ci_result --wait
check "green older and newer in progress then success: reuse the newer" reuses 101
check "  after waiting for it" waited 2

sandbox
runs "$(run 100 1 "$T1")"
CALL=1 record 100 1 in_progress
CALL=2 record 100 1 completed failure
ci_result --wait
check "in progress then failure: no reuse" declines
check "  with its conclusion" said "ended with failure"

sandbox
runs "$(run 100 1 "$T1")"
record 100 1 in_progress
WAIT=3 ci_result --wait
check "in progress beyond the bound: no reuse" declines
check "  and says so" said "reason=CI run 100 of $SHA (attempt 1) is still in_progress after 3s"
check "  after waiting the bound and no longer" waited 3

sandbox
runs "$(run 100 1 "$T1")"
record 100 1 in_progress
WAIT=45 POLL=30 ci_result --wait
check "the wait never sleeps past its deadline" slept "sleep 30 sleep 15 "
check "  and then stops: no reuse" declines

sandbox
runs "$(run 100 1 "$T1")"
record 100 1 in_progress
WAIT=100 POLL=30 MOCK_GH_SLOW=20 ci_result --wait
check "slow API calls count against the deadline: no reuse" declines
check "  after one sleep, not four" waited 1

sandbox
runs "$(run 100 1 "$T1")"
CALL=1 record 100 1 in_progress
RUNS_CALL=2 runs "$(run 100 1 "$T1")" "$(run 101 1 "$T2")"
record 101 1 completed failure
ci_result --wait
check "a newer run that appears while waiting decides: no reuse" declines
check "  and names it" said "run_id=101"

sandbox
runs "$(run 100 2 "$T1")"
record 100 2 completed success
ci_result --wait
check "success on attempt 2: reuse it" reuses 100
check "  and says which attempt" said "(attempt 2) succeeded"

sandbox
runs "$(run 100 2 "$T1")"
record 100 2 completed failure
ci_result --wait
check "latest attempt failed after an earlier success: no reuse" declines

sandbox
runs "$(run 100 1 "$T1")"
record 100 2 in_progress
ci_result --wait
check "the list says attempt 1 succeeded, the record says attempt 2 runs: no reuse" declines
check "  and names attempt 2" said "(attempt 2) is still in_progress"

sandbox
runs "$(run 100 1 "$T1" pull_request)"
REC_EVENT=pull_request record 100 1 completed success
ci_result --wait
check "a green pull request run of the same commit: ignored" declines
check "  as if there were none" said "reason=no CI run"

sandbox
runs "$(run 100 1 "$T1")" "$(run 101 1 "$T2" pull_request)"
record 100 1 completed success
REC_EVENT=pull_request record 101 1 completed failure
ci_result --wait
check "a newer pull request run beside a green push run: the push run decides" reuses 100

sandbox
runs "$(run 100 1 "$T1" push feature)"
REC_BRANCH=feature record 100 1 completed success
ci_result --wait
check "a green run on another branch: ignored" declines

sandbox
runs "$(run 100 1 "$T1" schedule)"
REC_EVENT=schedule record 100 1 completed success
ci_result --wait
check "a green scheduled run: ignored" declines

sandbox
runs "$(run 100 1 "$T1")" "$(run 101 1 "$T2" push main "$OTHER_SHA")"
record 100 1 completed success
ci_result --wait
check "a run of another commit in the answer: ignored" reuses 100

sandbox
printf '{"id":%s,"workflow_id":999,"path":".github/workflows/ci.yml","head_sha":"%s","head_branch":"main","event":"push","run_attempt":1,"created_at":"%s"}' \
  101 "$SHA" "$T2" >"$WORK/case/other"
runs "$(run 100 1 "$T1")" "$(cat "$WORK/case/other")"
record 100 1 completed success
ci_result --wait
check "a run of another workflow in the answer: ignored" reuses 100

sandbox
printf '{"id":%s,"name":"CI","path":".github/workflows/other.yml"}' "$WORKFLOW_ID" >"$STATE/api/workflow"
ci_result --wait
check "the workflow file is not ci.yml: no reuse" declines

# --- unexpected answers ----------------------------------------------------------------------

sandbox
runs "$(run 100 1 "$T1")"
record 100 1 completed success
MOCK_GH_DOWN=1 ci_result --wait
check "API error: no reuse, and the script itself succeeds" declines
check "  and says why" said "reason=cannot read the CI workflow"

sandbox
runs "$(run 100 1 "$T1")"
record 100 1 completed success
MOCK_GH_HANG=run.100 CALL_TIMEOUT=1 ci_result --wait
check "an API call that times out: no reuse" declines
check "  and says why" said "reason=cannot read CI run 100"

sandbox
runs "$(run 100 1 "$T1")"
ci_result --wait
check "the run's record cannot be read: no reuse" declines
check "  and says why" said "reason=cannot read CI run 100"

sandbox
printf '{"total_count":1,"workflow_runs":[{"id":100,' >"$STATE/api/runs"
ci_result --wait
check "malformed JSON: no reuse" declines
check "  and says why" said "reason=cannot read the CI runs"

sandbox
printf '{"total_count":1,"workflow_runs":[{"id":"100","workflow_id":%s}]}' "$WORKFLOW_ID" >"$STATE/api/runs"
ci_result --wait
check "a run without the expected fields: no reuse" declines

sandbox
runs "$(run 100 1 "$T1")"
sed -i 's/"total_count":1/"total_count":101/' "$STATE/api/runs"
ci_result --wait
check "more runs than one page: no reuse" declines

sandbox
runs "$(run 100 1 "$T1")"
record 100 1 completed 'success\nfailure'
ci_result --wait
check "a conclusion with a newline in it: no reuse" declines
check "  and says why" said "reason=CI run 100 of $SHA answered with unexpected values"

sandbox
runs "$(run 100 1 "$T1")"
record 100 1 completed 'success '
ci_result --wait
check "a conclusion with a trailing space: no reuse" declines

sandbox
runs "$(run 100 1 "$T1")"
record 100 1 'completed ' success
ci_result --wait
check "a status with a trailing space: no reuse" declines

sandbox
runs "$(run 100 1 "$T1")"
record 100 1 stale
ci_result --wait
check "an unknown status: no reuse" declines
check "  without waiting" waited 0

sandbox
runs "$(run 100 1 "$T1")"
record 100 1 completed weird
ci_result --wait
check "an unknown conclusion: no reuse" declines

for field in REC_ID=999 REC_SHA=$OTHER_SHA REC_BRANCH=feature REC_EVENT=pull_request; do
  sandbox
  runs "$(run 100 1 "$T1")"
  declare "$field"
  record 100 1 completed success
  unset "${field%%=*}"
  ci_result --wait
  check "a record that does not match the run (${field%%=*}): no reuse" declines
done

# --- final check -----------------------------------------------------------------------------

sandbox
runs "$(run 100 1 "$T1")"
record 100 1 completed success
ci_result --expect-run 100
check "final check, the run unchanged: go on" [ $RC -eq 0 ]
check "  and says so" said "reuse=true"

sandbox
runs "$(run 100 1 "$T1")" "$(run 101 1 "$T2")"
record 100 1 completed success
record 101 1 completed success
ci_result --expect-run 100
check "final check, a newer run appeared: stop" [ $RC -eq 1 ]
check "  and says why" said "reason=CI run 101 of $SHA (attempt 1) is newer than the reused run 100"

sandbox
runs "$(run 100 1 "$T1")" "$(run 101 1 "$T3")"
record 100 1 completed success
record 101 1 in_progress
ci_result --expect-run 100
check "final check, a newer run still running: stop" [ $RC -eq 1 ]
check "  without waiting" waited 0

sandbox
runs "$(run 100 1 "$T1")"
record 100 2 in_progress
ci_result --expect-run 100
check "final check, the list says attempt 1 succeeded, the record says attempt 2 runs: stop" [ $RC -eq 1 ]
check "  and says why" said "reason=CI run 100 of $SHA (attempt 2) is in_progress"

sandbox
runs "$(run 100 2 "$T1")"
record 100 2 completed failure
ci_result --expect-run 100
check "final check, a new attempt failed: stop" [ $RC -eq 1 ]

sandbox
runs "$(run 100 1 "$T1")"
record 100 1 completed 'success '
ci_result --expect-run 100
check "final check, an unexpected conclusion: stop" [ $RC -eq 1 ]

sandbox
ci_result --expect-run 100
check "final check, no run any more: stop" [ $RC -eq 1 ]

sandbox
MOCK_GH_DOWN=1 ci_result --expect-run 100
check "final check, API error: stop" [ $RC -eq 1 ]

sandbox
runs "$(run 100 1 "$T1")"
record 100 1 completed success
MOCK_GH_HANG=runs CALL_TIMEOUT=1 ci_result --expect-run 100
check "final check, an API call that times out: stop" [ $RC -eq 1 ]

# --- usage -----------------------------------------------------------------------------------

sandbox
ci_result
check "no mode: usage error" [ $RC -eq 2 ]
(PATH="$WORK/bin:$PATH" GH_REPO=owner/repo bash "$REPO/scripts/ci-result.sh" --sha abc --wait) >/dev/null 2>&1
check "a short SHA: usage error" [ $? -eq 2 ]
(PATH="$WORK/bin:$PATH" GH_REPO="" bash "$REPO/scripts/ci-result.sh" --sha "$SHA" --wait) >/dev/null 2>&1
check "no GH_REPO: usage error" [ $? -eq 2 ]
CALL_TIMEOUT=0 ci_result --wait
check "a call timeout of 0: usage error" [ $RC -eq 2 ]

echo "ci-result.sh: $PASSED passed, $FAILED failed"
[ $FAILED -eq 0 ]
