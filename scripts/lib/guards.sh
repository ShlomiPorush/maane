#!/usr/bin/env bash
# Repository guards. scripts/verify.sh runs this inside the toolchain container; run it there, not on the host.
# Usage: bash scripts/lib/guards.sh [ROOT]
# Checks tracked files and new files that are not ignored in ROOT (default: this repository), so a violation
# fails before it is committed. scripts/lib/test-guards.sh runs it against a scratch repository.
set -euo pipefail
cd "${1:-$(dirname "${BASH_SOURCE[0]}")/../..}"
# grep -P reads \x{...} code points only in a UTF-8 locale; in C or POSIX it fails on the Hebrew range.
export LC_ALL=C.UTF-8

HEBREW_LOCALE=packages/shared/src/locales/he.json
ENGLISH_LOCALE=packages/shared/src/locales/en.json

fail=0
files=()
while IFS= read -r -d '' file; do
  [ -f "$file" ] && [ ! -L "$file" ] && files+=("$file")
done < <(git ls-files -z -co --exclude-standard)

hebrew_files=()
ip_files=()
for file in "${files[@]}"; do
  [ "$file" = "$HEBREW_LOCALE" ] || hebrew_files+=("$file")
  # The lockfile is machine-written and holds version strings and hashes only; it is reviewed through
  # package.json.
  [ "$file" = pnpm-lock.yaml ] || ip_files+=("$file")
done

# Runs grep with the given arguments (ending with -- and the files) and prints file:line[:match].
# No match is fine; a grep error (exit 2) stops the guards, so a broken pattern never passes silently.
search() {
  local rc=0
  [ "${*: -1}" = -- ] && return 0
  grep -HIn "$@" || rc=$?
  if [ "$rc" -gt 1 ]; then
    echo "error: grep failed (exit $rc)" >&2
    exit 2
  fi
}

# Prints file:line, and what matched only outside CI: CI logs of a public repository must not repeat it.
report() {
  local what="$1" file line match
  while IFS=: read -r file line match; do
    if [ -n "${CI:-}" ]; then
      echo "  $file:$line"
    else
      echo "  $file:$line: ${what:-$match}"
    fi
  done
}

echo "--- Hebrew only in $HEBREW_LOCALE"
hebrew="$(search -l -P '[\x{0590}-\x{05FF}\x{FB1D}-\x{FB4F}]' -- "${hebrew_files[@]}")"
if [ -n "$hebrew" ]; then
  echo "Hebrew text is allowed only in $HEBREW_LOCALE. Write it in tests as \\u escapes or MIME-encoded:"
  while IFS= read -r file; do echo "  $file"; done <<<"$hebrew"
  fail=1
fi

echo "--- No literal bidirectional control characters"
bidi="$(search -P '[\x{200E}\x{200F}\x{202A}-\x{202E}\x{2066}-\x{2069}]' -- "${files[@]}")"
if [ -n "$bidi" ]; then
  echo "Write bidirectional control characters as escapes (\\u200F), never as literal characters:"
  report "a bidirectional control character" <<<"$bidi"
  fail=1
fi

echo "--- IPv4 addresses only from loopback, 0.0.0.0 and the documentation ranges"
# Four dot-separated numbers inside a longer dotted run (1.2.3.4.5) are not an address.
ips="$(search -o -P '(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?!\.?\d)' -- "${ip_files[@]}" |
  awk -F: '{
    n = split($NF, o, ".")
    for (i = 1; i <= n; i++) if (o[i] + 0 > 255) next
    if ($NF == "127.0.0.1" || $NF == "0.0.0.0") next
    if ($NF ~ /^(192\.0\.2|198\.51\.100|203\.0\.113)\./) next
    print
  }')"
if [ -n "$ips" ]; then
  echo "IP addresses are not allowed in the repository (use 192.0.2.x, 198.51.100.x or 203.0.113.x in examples):"
  report "" <<<"$ips"
  fail=1
fi

echo "--- Environment files only as examples, with no secret values"
# The repository holds no value a stack runs on, not even a "fake" or "dev-only" one: stacks generate theirs.
env_examples=()
for file in "${files[@]}"; do
  case "${file##*/}" in
    .env.example | *.env.example) env_examples+=("$file") ;;
    *.example) ;;
    .env | .env.* | *.env)
      echo "  $file: an environment file; keep only an example (<name>.example) with empty values"
      fail=1
      ;;
  esac
done
secret_values="$(search -E \
  '^[[:space:]]*(export[[:space:]]+)?(DATABASE_URL|[A-Z0-9_]*(PASSWORD|SECRET|SECRETS|KEY|KEYS|TOKEN))[[:space:]]*=[[:space:]]*[^[:space:]#]' \
  -- "${env_examples[@]}")"
if [ -n "$secret_values" ]; then
  echo "Example environment files must leave secrets and connection strings empty:"
  report "a value" <<<"$secret_values"
  fail=1
fi

echo "--- No secret-like values"
# High-confidence formats only: private key blocks, known token formats, credentials inside a URL.
# Tests that need such a value assemble it at run time, so the literal text never matches.
secret_pattern='-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----'
secret_pattern+='|\bgh[pousr]_[A-Za-z0-9]{36,}'
secret_pattern+='|\bgithub_pat_[A-Za-z0-9_]{22,}'
secret_pattern+='|\bAKIA[0-9A-Z]{16}\b'
secret_pattern+='|\bxox[abprs]-[A-Za-z0-9-]{10,}'
secret_pattern+='|\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}'
secret_pattern+='|\bAIza[0-9A-Za-z_-]{35}'
secret_pattern+='|\bapi-[A-F0-9]{32}\b'
secret_pattern+='|\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'
secret_pattern+='|\b[a-z][a-z0-9+.-]*://[A-Za-z0-9._%+-]+:[^\s/@'"'"'"$<{*\[\]]+@'
secrets="$(search -P -e "$secret_pattern" -- "${files[@]}")"
if [ -n "$secrets" ]; then
  echo "A secret-like value is in the repository. Remove it, and replace it wherever it is used:"
  report "a secret-like value" <<<"$secrets"
  fail=1
fi

echo "--- No build: in the Compose files"
compose_files=()
for file in docker-compose.yml docker-compose-dev.yml docker/docker-compose-dev.example.yml; do
  [ -f "$file" ] && compose_files+=("$file")
done
if [ ${#compose_files[@]} -gt 0 ] && grep -nE '^[[:space:]]*build[[:space:]]*:' "${compose_files[@]}"; then
  echo "Compose files must not contain build:. Images are built by the scripts."
  fail=1
fi

echo "--- Local deny list"
deny=docs/private/deny-list.txt
if [ -f "$deny" ]; then
  while IFS= read -r term || [ -n "$term" ]; do
    term="${term%$'\r'}"
    term="${term#"${term%%[![:space:]]*}"}"
    term="${term%"${term##*[![:space:]]}"}"
    [ -z "$term" ] || [[ "$term" == \#* ]] && continue
    hits="$(search -i -w -F -e "$term" -- "${files[@]}")"
    if [ -n "$hits" ]; then
      echo "A term from $deny appears in the repository:"
      report "$term" <<<"$hits"
      fail=1
    fi
  done <"$deny"
else
  echo "  $deny not found; skipped (it exists only on the owner's machine)"
fi

echo "--- Locale files have the same keys"
node -e '
  const fs = require("node:fs")
  const keys = (v, p = "") => (typeof v === "object" && v !== null)
    ? Object.entries(v).flatMap(([k, x]) => keys(x, p ? p + "." + k : k)) : [p]
  const [a, b] = process.argv.slice(1).map((f) => new Set(keys(JSON.parse(fs.readFileSync(f, "utf8")))))
  const missing = (x, y, name) => [...x].filter((k) => !y.has(k)).map((k) => "  missing in " + name + ": " + k)
  const problems = [...missing(a, b, "he.json"), ...missing(b, a, "en.json")]
  if (problems.length) { console.log(problems.join("\n")); process.exit(1) }
' "$ENGLISH_LOCALE" "$HEBREW_LOCALE" || {
  echo "en.json and he.json must have the same keys."
  fail=1
}

echo "--- LF line endings"
# Index (i/) and working tree (w/) line endings; a file with CRLF in either fails.
crlf="$(git ls-files --eol -co --exclude-standard | awk '$1 ~ /^i\/(crlf|mixed)$/ || $2 ~ /^w\/(crlf|mixed)$/ { print $NF }')"
if [ -n "$crlf" ]; then
  echo "Files must use LF line endings:"
  while IFS= read -r file; do echo "  $file"; done <<<"$crlf"
  fail=1
fi

echo "--- GitHub Actions pinned to a commit SHA"
workflow_files=()
for file in "${files[@]}"; do
  [[ "$file" == .github/workflows/*.yml || "$file" == .github/workflows/*.yaml || "$file" == .github/actions/* ]] &&
    workflow_files+=("$file")
done
unpinned="$(search -E '^[[:space:]]*(-[[:space:]]*)?uses:[[:space:]]*' -- "${workflow_files[@]}" |
  grep -vE 'uses:[[:space:]]*["'"'"']?(\./|docker://[^[:space:]]+@sha256:[0-9a-f]{64})' |
  grep -vE 'uses:[[:space:]]*["'"'"']?[^[:space:]@"'"'"']+@[0-9a-f]{40}([[:space:]"'"'"']|$)' || true)"
if [ -n "$unpinned" ]; then
  echo "Pin every action to a full commit SHA (with the version in a comment):"
  report "" <<<"$unpinned"
  fail=1
fi

echo "--- Shell scripts"
scripts=()
for file in "${files[@]}"; do
  [[ "$file" == scripts/*.sh || "$file" == scripts/lib/*.sh ]] && scripts+=("$file")
done
if [ ${#scripts[@]} -gt 0 ]; then
  shellcheck -x "${scripts[@]}" || fail=1
  shfmt -d -i 2 -ci "${scripts[@]}" || {
    echo "Run: shfmt -w -i 2 -ci scripts"
    fail=1
  }
fi
while read -r mode _ _ path; do
  [[ "$path" == scripts/lib/* ]] && continue
  [ "$mode" = 100755 ] || {
    echo "$path is not executable: git update-index --chmod=+x $path"
    fail=1
  }
done < <(git ls-files -s 'scripts/*.sh')

exit "$fail"
