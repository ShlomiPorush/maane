#!/usr/bin/env bash
# Tests the wiring of .github/workflows/release.yml: which jobs and steps run on the two CI paths (a
# reused green CI run, or the CI run by the release) with and without dry_run, and what the Release
# step passes to scripts/release.sh. The job and step conditions are read from the file and evaluated
# with Node against each case; the Release step's script runs with stand-ins for git, docker and
# release.sh. Run with the guards (scripts/lib/guards.sh).
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKFLOW="$REPO/.github/workflows/release.yml"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/maane-release-workflow-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
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
  fi
}

# --- the parts of the workflow ---------------------------------------------------------------

# Writes the conditions and the Release step's script to $WORK: verify-if, release-if, recheck-if,
# release-step-if (empty when the step has none) and release-run. Fails when a part is missing.
node - "$WORKFLOW" "$WORK" <<'EOF' || {
const fs = require("node:fs")
const [file, out] = process.argv.slice(2)
const lines = fs.readFileSync(file, "utf8").split("\n")
const fail = (what) => { console.error("release.yml: " + what); process.exit(1) }
const block = (start, isEnd) => {
  const i = lines.findIndex((l) => l === start)
  if (i < 0) fail("no line " + JSON.stringify(start))
  let j = i + 1
  while (j < lines.length && !isEnd(lines[j])) j++
  return lines.slice(i + 1, j)
}
const job = (name) => block("  " + name + ":", (l) => /^  \S/.test(l))
const step = (jobLines, name) => {
  const i = jobLines.findIndex((l) => l === "      - name: " + name)
  if (i < 0) fail("no step " + name)
  let j = i + 1
  while (j < jobLines.length && !/^      - /.test(jobLines[j])) j++
  return jobLines.slice(i + 1, j)
}
const plainIf = (part) => (part.find((l) => /^ *if: /.test(l)) || "").replace(/^ *if: /, "")
const foldedIf = (part) => {
  const i = part.findIndex((l) => l === "    if: >-")
  if (i < 0) fail("the release job has no folded if")
  const folded = []
  for (let j = i + 1; j < part.length && /^      \S/.test(part[j]); j++) folded.push(part[j].trim())
  return folded.join(" ")
}
const release = job("release")
const verifyIf = plainIf(job("verify").filter((l) => /^    \S/.test(l)))
const recheck = step(release, "Check the reused CI run again")
const releaseStep = step(release, "Release")
const r = releaseStep.findIndex((l) => l === "        run: |")
if (r < 0) fail("the Release step has no run block")
const run = []
for (let j = r + 1; j < releaseStep.length && (releaseStep[j] === "" || /^          /.test(releaseStep[j])); j++)
  run.push(releaseStep[j].slice(10))
fs.writeFileSync(out + "/verify-if", verifyIf)
fs.writeFileSync(out + "/release-if", foldedIf(release))
fs.writeFileSync(out + "/recheck-if", plainIf(recheck))
fs.writeFileSync(out + "/release-step-if", plainIf(releaseStep))
fs.writeFileSync(out + "/release-run", run.join("\n") + "\n")
EOF
  echo "release-workflow: cannot read the parts of release.yml"
  exit 1
}

# Evaluates a condition for one case: evaluate KIND EXPR FIND_RESULT REUSE VERIFY_RESULT DRY_RUN
# [CANCELLED] [REF], with KIND job or step. Exits 0 when it holds, 1 when it does not and 2 on an
# expression with names or operators these conditions do not use. A job condition without a status
# function gets GitHub's implicit success() of the jobs it needs; for a step, the earlier steps of
# its job are taken to have succeeded.
evaluate() {
  node - "$@" <<'EOF'
const [kind, expr, find, reuse, verify, dryRun, cancelled = "false", ref = "refs/heads/main"] = process.argv.slice(2)
if (!/^[A-Za-z0-9_.'()!&|=/ -]*$/.test(expr) || expr.trim() === "") {
  console.error("unexpected expression: " + expr)
  process.exit(2)
}
const needs = { find: { result: find, outputs: { reuse, "run-id": "100" } }, verify: { result: verify } }
const github = { ref }
const inputs = { dry_run: dryRun === "true", bump: "patch" }
const isCancelled = () => cancelled === "true"
const success = () => !isCancelled() && (kind === "step" || Object.values(needs).every((n) => n.result === "success"))
const statusFn = /\b(success|failure|always|cancelled)\(/.test(expr)
const value = new Function("needs", "github", "inputs", "cancelled", "success", "return " + expr)(
  needs, github, inputs, isCancelled, success)
process.exit((statusFn ? value : success() && value) ? 0 : 1)
EOF
}
runs() { evaluate "$@"; }
skips() {
  evaluate "$@"
  [ $? -eq 1 ]
}

VERIFY_IF="$(cat "$WORK/verify-if")"
RELEASE_IF="$(cat "$WORK/release-if")"
RECHECK_IF="$(cat "$WORK/recheck-if")"

# --- the two paths, with and without a dry run -----------------------------------------------

# The verify job needs only find, so its own result is given as success.
for dry in false true; do
  check "reused CI (dry_run=$dry): verify is skipped" skips job "$VERIFY_IF" success true success "$dry"
  check "reused CI (dry_run=$dry): the release job runs" runs job "$RELEASE_IF" success true skipped "$dry"
  check "reused CI (dry_run=$dry): the reused run is checked again" runs step "$RECHECK_IF" success true skipped "$dry"
  check "fresh CI (dry_run=$dry): verify runs" runs job "$VERIFY_IF" success false success "$dry"
  check "fresh CI (dry_run=$dry): the release job runs after it" runs job "$RELEASE_IF" success false success "$dry"
  check "fresh CI (dry_run=$dry): no check of a reused run" skips step "$RECHECK_IF" success false success "$dry"
done
check "the Release step runs whenever its job runs" [ -z "$(cat "$WORK/release-step-if")" ]

# --- what stops the release job --------------------------------------------------------------

for verify in failure cancelled skipped; do
  check "fresh CI, verify $verify: no release" skips job "$RELEASE_IF" success false "$verify" false
done
check "reused CI, verify ran anyway: no release" skips job "$RELEASE_IF" success true success false
for find in failure cancelled skipped; do
  check "find $find: no release" skips job "$RELEASE_IF" "$find" false skipped false
  check "find $find: no verify" skips job "$VERIFY_IF" "$find" false success false
done
check "find gave no result: no release" skips job "$RELEASE_IF" success "" skipped false
check "find gave no result: no verify" skips job "$VERIFY_IF" success "" success false
check "the run was cancelled: no release" skips job "$RELEASE_IF" success true skipped false true
check "not on main: no release" skips job "$RELEASE_IF" success true skipped false false refs/heads/other
check "not on main: no verify" skips job "$VERIFY_IF" success false success false false refs/heads/other

# --- what the Release step passes to release.sh ----------------------------------------------

mkdir -p "$WORK/bin" "$WORK/repo/scripts"
cat >"$WORK/bin/git" <<'EOF'
#!/usr/bin/env bash
echo "git $*" >>"$CALLS"
EOF
cat >"$WORK/bin/docker" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
echo "docker $*" >>"$CALLS"
EOF
cat >"$WORK/repo/scripts/release.sh" <<'EOF'
#!/usr/bin/env bash
echo "release.sh $*" >>"$CALLS"
EOF
chmod +x "$WORK/bin/git" "$WORK/bin/docker" "$WORK/repo/scripts/release.sh"
SHA="1111111111111111111111111111111111111111"

# Runs the step's script as GitHub runs a bash step; sets RC.
release_step() {
  export CALLS="$WORK/calls"
  : >"$CALLS"
  (cd "$WORK/repo" && PATH="$WORK/bin:$PATH" BUMP=minor DRY_RUN="$1" VERIFIED_SHA="$SHA" GH_TOKEN=token \
    GITHUB_ACTOR=actor GH_REPO=owner/repo bash --noprofile --norc -eo pipefail "$WORK/release-run") >/dev/null 2>&1
  RC=$?
}
called() { grep -qxF "$1" "$CALLS"; }

release_step true
check "dry_run=true: the step succeeds" [ $RC -eq 0 ]
check "  and passes --dry-run" called "release.sh --target ghcr --bump minor --skip-verify --expect-sha $SHA --dry-run"

release_step false
check "dry_run=false: the step succeeds" [ $RC -eq 0 ]
check "  and releases without --dry-run" called "release.sh --target ghcr --bump minor --skip-verify --expect-sha $SHA"
check "  after logging in to GHCR" called "docker login ghcr.io --username actor --password-stdin"

# --- the CI the release calls ----------------------------------------------------------------

# Read as lines, not through yq: YAML 1.1 reads the key "on" as a boolean.
CI_FILE="$REPO/.github/workflows/ci.yml"
check "the verify job calls ci.yml" grep -qx "    uses: ./.github/workflows/ci.yml" "$WORKFLOW"
check "ci.yml can be called (workflow_call)" grep -qx "  workflow_call:" "$CI_FILE"
check "ci.yml gives every run but a pull request's a group of its own" \
  grep -qF "format('pr-{0}', github.event.pull_request.number) || format('run-{0}', github.run_id) }}" "$CI_FILE"

echo "release-workflow: $PASSED passed, $FAILED failed"
[ $FAILED -eq 0 ]
