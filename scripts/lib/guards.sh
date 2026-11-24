#!/usr/bin/env bash
set -euo pipefail
cd "${1:-$(dirname "${BASH_SOURCE[0]}")/../..}"
export LC_ALL=C.UTF-8

HEBREW_LOCALE=packages/shared/src/locales/he.json
ENGLISH_LOCALE=packages/shared/src/locales/en.json
# The only kinds of file that may hold binary content. Text guards cannot read them.
BINARY_EXTENSIONS='png|jpg|jpeg|gif|webp|ico|woff2|pdf|mmdb'

fail=0

listing="$(mktemp)"
eol_listing="$(mktemp)"
trap 'rm -f -- "$listing" "$eol_listing"' EXIT
git ls-files -z -co --exclude-standard >"$listing" || {
  echo "error: git ls-files failed" >&2
  exit 2
}
git ls-files -z --eol -co --exclude-standard >"$eol_listing" || {
  echo "error: git ls-files --eol failed" >&2
  exit 2
}

files=()
while IFS= read -r -d '' file; do
  [ -f "$file" ] && [ ! -L "$file" ] && files+=("$file")
done <"$listing"

hebrew_files=()
text_files=()
for file in "${files[@]}"; do
  [ "$file" = "$HEBREW_LOCALE" ] || hebrew_files+=("$file")
  [[ "${file,,}" =~ \.($BINARY_EXTENSIONS)$ ]] || text_files+=("$file")
done

binary_files=()
crlf_files=()
while IFS= read -r -d '' entry; do
  path="${entry#*$'\t'}"
  read -r index worktree _ <<<"${entry%%$'\t'*}"
  if [ "$index" = i/-text ] || [ "$worktree" = w/-text ]; then
    [[ "${path,,}" =~ \.($BINARY_EXTENSIONS)$ ]] || binary_files+=("$path")
  fi
  if [[ "$index" =~ ^i/(crlf|mixed)$ || "$worktree" =~ ^w/(crlf|mixed)$ ]]; then crlf_files+=("$path"); fi
done <"$eol_listing"

search() {
  local rc=0
  [ "${*: -1}" = -- ] && return 0
  grep -HIn "$@" || rc=$?
  if [ "$rc" -gt 1 ]; then
    echo "error: grep failed (exit $rc)" >&2
    exit 2
  fi
}

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

echo "--- Binary content only in images, fonts, PDFs and GeoIP databases"
if [ ${#binary_files[@]} -gt 0 ]; then
  echo "Only images, fonts, PDFs and GeoIP databases may be binary; the text guards cannot read these:"
  printf '  %s\n' "${binary_files[@]}"
  fail=1
fi

echo "--- Text files are valid UTF-8"
invalid="$(search -l -a -x -v '.*' -- "${text_files[@]}")"
if [ -n "$invalid" ]; then
  echo "These files are not valid UTF-8; the text guards cannot read them reliably:"
  while IFS= read -r file; do echo "  $file"; done <<<"$invalid"
  fail=1
fi

echo "--- Hebrew only in $HEBREW_LOCALE"
hebrew="$(search -l -P '[\x{0590}-\x{05FF}\x{FB1D}-\x{FB4F}]' -- "${hebrew_files[@]}")"
if [ -n "$hebrew" ]; then
  echo "Hebrew text is allowed only in $HEBREW_LOCALE. Write it in tests as code points or MIME-encoded:"
  while IFS= read -r file; do echo "  $file"; done <<<"$hebrew"
  fail=1
fi

echo "--- No literal bidirectional control characters"
bidi="$(search -P '[\x{061C}\x{200E}\x{200F}\x{202A}-\x{202E}\x{2066}-\x{2069}]' -- "${files[@]}")"
if [ -n "$bidi" ]; then
  echo "Write bidirectional control characters as escapes, never as literal characters:"
  report "a bidirectional control character" <<<"$bidi"
  fail=1
fi

echo "--- IPv4 addresses only from loopback, 0.0.0.0 and the documentation ranges"
ips="$(search -o -P '(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?!\.?\d)' -- "${files[@]}" |
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
env_examples=()
for file in "${files[@]}"; do
  name="${file##*/}"
  case "$name" in
    .env | .env.* | *.env | *.env.*)
      if [[ "$name" == *.example ]]; then
        env_examples+=("$file")
      else
        echo "  $file: an environment file; keep only an example (<name>.example) with empty values"
        fail=1
      fi
      ;;
  esac
done
secret_values="$(search -P \
  '^\s*(export\s+)?(DATABASE_URL|[A-Z0-9_]*(PASSWORD|SECRET|SECRETS|KEY|KEYS|TOKEN))\s*=\s*(?!""\s*(#.*)?$|'"''"'\s*(#.*)?$)[^\s#]' \
  -- "${env_examples[@]}")"
if [ -n "$secret_values" ]; then
  echo "Example environment files must leave secrets and connection strings empty:"
  report "a value" <<<"$secret_values"
  fail=1
fi

echo "--- No secret-like values"
secret_pattern='-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----'
secret_pattern+='|\bgh[pousr]_[A-Za-z0-9]{36,}'
secret_pattern+='|\bgithub_pat_[A-Za-z0-9_]{22,}'
secret_pattern+='|\bAKIA[0-9A-Z]{16}\b'
secret_pattern+='|\bxox[abprs]-[A-Za-z0-9-]{10,}'
secret_pattern+='|\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}'
secret_pattern+='|\bAIza[0-9A-Za-z_-]{35}'
secret_pattern+='|\bapi-[A-F0-9]{32}\b'
secret_pattern+='|\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'
secret_pattern+='|\b[A-Za-z][A-Za-z0-9+.-]*://[^\s/:@?#]*:'
secret_pattern+='(?!(?:\$[A-Za-z_][A-Za-z0-9_]*|\$\{(?:[^{}]|\{[^{}]*\})*\}|%s|<[^\s<>@]*>|\*+)@)[^\s/@?#]+@'
secrets="$(search -P -e "$secret_pattern" -- "${files[@]}")"
if [ -n "$secrets" ]; then
  echo "A secret-like value is in the repository. Remove it, and replace it wherever it is used:"
  report "a secret-like value" <<<"$secrets"
  fail=1
fi

echo "--- No build: in the Compose files"
for file in docker-compose.yml docker-compose-dev.yml docker/docker-compose-dev.example.yml; do
  [ -f "$file" ] || continue
  if ! built="$(yq -r '[(.services // {})[]? | select(type == "object" and has("build"))] | length' "$file" 2>/dev/null)"; then
    echo "  $file: not valid YAML"
    fail=1
  elif [ "$built" != 0 ]; then
    echo "  $file: $built service(s) with build:. Compose files must not build; the scripts build images."
    fail=1
  fi
done

echo "--- Compose interpolates only the plain \${VAR} form"
for file in docker-compose.yml docker-compose-dev.yml docker/docker-compose-dev.example.yml; do
  [ -f "$file" ] || continue
  if ! values="$(yq -r '.. | strings' "$file" 2>/dev/null)"; then
    echo "  $file: not valid YAML"
    fail=1
    continue
  fi
  # shellcheck disable=SC2016 # regular expressions, not shell expansions
  if grep -qP '\$(?!\{[A-Za-z_][A-Za-z0-9_]*\})' <<<"${values//\$\$/}"; then
    # shellcheck disable=SC2016
    names="$(grep -oP '\$(?!\{[A-Za-z_][A-Za-z0-9_]*\})\{?\K[A-Za-z_][A-Za-z0-9_]*' <<<"${values//\$\$/}" |
      sort -u | tr '\n' ' ' || true)"
    echo "  $file: write a variable as \${VAR} or a literal value: ${names:-a dollar sign without a name}"
    [ "$file" != docker-compose-dev.yml ] ||
      echo "  Write its variables as docker/docker-compose-dev.example.yml does; keep your own changes."
    fail=1
  fi
done

echo "--- Secrets reach containers only through env_file"
secret_name='(DATABASE_URL|[A-Z0-9_]*(PASSWORD|SECRET|SECRETS|KEY|KEYS|TOKEN))'
for file in docker-compose.yml docker-compose-dev.yml docker/docker-compose-dev.example.yml; do
  [ -f "$file" ] || continue
  # shellcheck disable=SC2016 # a jq program, not a shell expansion
  if ! names="$(yq -r '(.services // {})[]? | select(type == "object") | .environment // empty |
      if type == "object" then keys[] elif type == "array" then .[] | tostring | sub("=.*"; "") else empty end' \
    "$file" 2>/dev/null)" || ! values="$(yq -r '.. | strings' "$file" 2>/dev/null)"; then
    echo "  $file: not valid YAML"
    fail=1
    continue
  fi
  set_names="$(grep -xE "$secret_name" <<<"$names" | sort -u | tr '\n' ' ' || true)"
  interpolated="$(grep -oP '(?<!\$)(?:\$\$)*\$\{?\K'"$secret_name"'\b' <<<"$values" | sort -u | tr '\n' ' ' || true)"
  if [ -n "$set_names$interpolated" ]; then
    [ -z "$set_names" ] || echo "  $file: set under environment: ${set_names% }"
    [ -z "$interpolated" ] || echo "  $file: interpolated by Compose: ${interpolated% }"
    echo "  Put secrets in an env_file the scripts or the deployment generate; interpolate only values that are not secret."
    fail=1
  fi
done

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
  const read = (f) => {
    try { return JSON.parse(fs.readFileSync(f, "utf8")) } catch { console.log("  " + f + " is not valid JSON"); process.exit(1) }
  }
  const [a, b] = process.argv.slice(1).map((f) => new Set(keys(read(f))))
  const missing = (x, y, name) => [...x].filter((k) => !y.has(k)).map((k) => "  missing in " + name + ": " + k)
  const problems = [...missing(a, b, "he.json"), ...missing(b, a, "en.json")]
  // In CI only the count: a key is file content, and a public CI log must not repeat it.
  if (problems.length) {
    console.log(process.env.CI ? "  " + problems.length + " key(s) differ between the locale files" : problems.join("\n"))
    process.exit(1)
  }
' "$ENGLISH_LOCALE" "$HEBREW_LOCALE" || {
  echo "en.json and he.json must be valid JSON with the same keys."
  fail=1
}

echo "--- LF line endings"
if [ ${#crlf_files[@]} -gt 0 ]; then
  echo "Files must use LF line endings:"
  printf '  %s\n' "${crlf_files[@]}"
  fail=1
fi

echo "--- GitHub Actions pinned to a commit SHA"
digest_pinned='^docker:'
digest_pinned+='//[^[:space:]]+@sha256:[0-9a-f]{64}$'
for file in "${files[@]}"; do
  [[ "$file" =~ ^\.github/(workflows/[^/]+|actions/.+/action)\.ya?ml$ ]] || continue
  if ! uses="$(yq -r '.. | objects | .uses? // empty | strings' "$file" 2>/dev/null)"; then
    echo "  $file: not valid YAML"
    fail=1
    continue
  fi
  while IFS= read -r action; do
    [ -z "$action" ] && continue
    [[ "$action" =~ ^\./ || "$action" =~ $digest_pinned ]] && continue
    [[ "$action" =~ ^[^[:space:]@]+@[0-9a-f]{40}$ ]] && continue
    echo "  $file: $action is not pinned to a full commit SHA (put the version in a comment)"
    fail=1
  done <<<"$uses"
done

echo "--- Shell scripts"
scripts=()
for file in "${files[@]}"; do
  [[ "$file" == scripts/*.sh || "$file" == scripts/lib/*.sh ]] && scripts+=("$file")
done
if [ ${#scripts[@]} -gt 0 ]; then
  if [ -n "${CI:-}" ]; then
    rc=0
    json="$(shellcheck -x -f json1 "${scripts[@]}" 2>/dev/null)" || rc=$?
    if [ "$rc" -gt 1 ] || ! findings="$(jq -r '.comments[] | "  \(.file):\(.line):\(.column): SC\(.code)"' <<<"$json")"; then
      echo "  shellcheck could not check the scripts"
      findings=""
      fail=1
    fi
    if [ -n "$findings" ]; then
      echo "$findings"
      echo "Run shellcheck -x on these scripts locally for the messages."
      fail=1
    fi
    for script in "${scripts[@]}"; do
      if ! listed="$(shfmt -l -i 2 -ci "$script" 2>/dev/null)"; then
        echo "  $script: shfmt cannot parse it"
        fail=1
      elif [ -n "$listed" ]; then
        echo "  $script: not formatted. Run: shfmt -w -i 2 -ci scripts"
        fail=1
      fi
    done
  else
    shellcheck -x -f gcc "${scripts[@]}" || fail=1
    if ! unformatted="$(shfmt -d -i 2 -ci "${scripts[@]}")" || [ -n "$unformatted" ]; then
      echo "$unformatted"
      echo "Run: shfmt -w -i 2 -ci scripts"
      fail=1
    fi
  fi
fi
modes="$(git ls-files -s -- 'scripts/*.sh')" || {
  echo "error: git ls-files -s failed" >&2
  exit 2
}
while read -r mode _ _ path; do
  [ -z "$path" ] && continue
  [[ "$path" == scripts/lib/* ]] && continue
  [ "$mode" = 100755 ] || {
    echo "$path is not executable: git update-index --chmod=+x $path"
    fail=1
  }
done <<<"$modes"

if [ $# -eq 0 ]; then
  echo "--- Release script: refusals and resume paths against a local remote"
  bash scripts/test-release.sh || fail=1

  echo "--- CI result script: which CI run a release reuses, against a stand-in gh"
  bash scripts/test-ci-result.sh || fail=1

  echo "--- Release workflow: jobs and steps on both CI paths, with and without dry_run"
  bash scripts/test-release-workflow.sh || fail=1

  echo "--- Stack secrets: the VAPID pair added to app.env only when missing, never replaced"
  bash scripts/test-stack-env.sh || fail=1
fi

exit "$fail"
