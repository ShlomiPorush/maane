#!/usr/bin/env bash
# Tests for ensure_vapid_keys (scripts/lib/common.sh), which scripts/local.sh, scripts/verify.sh, and
# scripts/try-pr.sh call after the image build: a data directory's app.env gets a VAPID pair only when it holds none,
# and an existing pair is never replaced. The image's generator is replaced by a stand-in that prints a pair new for
# each call, so no Docker is needed. Run with the guards (scripts/lib/guards.sh).
set -uo pipefail

# shellcheck source=scripts/lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/maane-stack-env-test.XXXXXX")"
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

# Characters of base64url from the kernel's generator, as many as asked for.
random_b64url() {
  LC_ALL=C tr -dc 'A-Za-z0-9_-' </dev/urandom | head -c "$1"
}

# The stand-in generator: GENERATOR=pair (a new pair), fail, or odd (a wrong line).
GENERATOR=pair
vapid_generator() {
  case "$GENERATOR" in
    pair) printf 'MAANE_VAPID_PUBLIC_KEY=%s\nMAANE_VAPID_PRIVATE_KEY=%s\n' "$(random_b64url 87)" "$(random_b64url 43)" ;;
    fail) return 1 ;;
    odd) printf 'MAANE_VAPID_PUBLIC_KEY=%s\n' "$(random_b64url 87)" ;;
  esac
}

# A data directory with the app.env ensure_stack_env writes, values new for each case.
new_dir() {
  local dir
  dir="$(mktemp -d "$WORK/stack.XXXXXX")"
  (
    umask 077
    printf 'DATABASE_URL=postgres://maane:%s@postgres:5432/maane\nMAANE_AUTH_SECRETS=1:%s\nMAANE_SETTINGS_KEYS=1:%s\n' \
      "$(random_hex)" "$(random_hex)" "$(random_hex)" >"$dir/app.env"
  )
  echo "$dir"
}

run() {
  (ensure_vapid_keys "$1" maane:test) >"$WORK/out" 2>&1
}

count() {
  grep -c "^$2=" "$1/app.env"
}

# Missing keys are added once, after the other values, and the file stays owner-only.
dir="$(new_dir)"
before="$(cat "$dir/app.env")"
check "adds a missing pair" run "$dir"
check "one public key" [ "$(count "$dir" MAANE_VAPID_PUBLIC_KEY)" = 1 ]
check "one private key" [ "$(count "$dir" MAANE_VAPID_PRIVATE_KEY)" = 1 ]
check "keeps the other values first and unchanged" [ "$(head -3 "$dir/app.env")" = "$before" ]
check "stays mode 600" [ "$(stat -c %a "$dir/app.env")" = 600 ]
check "never prints a key" bash -c "! grep -q 'MAANE_VAPID_PRIVATE_KEY=' '$WORK/out'"

# A second run, also with a generator that would make a new pair, changes nothing.
after="$(sha256sum <"$dir/app.env")"
check "a second run succeeds" run "$dir"
check "a second run replaces nothing" [ "$(sha256sum <"$dir/app.env")" = "$after" ]

# An app.env whose last line has no newline: the pair goes on lines of its own, the last value unchanged.
dir="$(new_dir)"
before="$(cat "$dir/app.env")"
truncate -s -1 "$dir/app.env"
check "adds a pair after a last line without a newline" run "$dir"
check "keeps the last value unchanged" [ "$(head -3 "$dir/app.env")" = "$before" ]
check "one public key after a last line without a newline" [ "$(count "$dir" MAANE_VAPID_PUBLIC_KEY)" = 1 ]
check "one private key after a last line without a newline" [ "$(count "$dir" MAANE_VAPID_PRIVATE_KEY)" = 1 ]
check "stays mode 600 after a last line without a newline" [ "$(stat -c %a "$dir/app.env")" = 600 ]

# Half a pair, or an empty key, is refused and left as it is.
for partial in "MAANE_VAPID_PUBLIC_KEY=$(random_b64url 87)" "MAANE_VAPID_PRIVATE_KEY=$(random_b64url 43)" \
  "MAANE_VAPID_PUBLIC_KEY=" "MAANE_VAPID_PUBLIC_KEY=
MAANE_VAPID_PRIVATE_KEY="; do
  dir="$(new_dir)"
  printf '%s\n' "$partial" >>"$dir/app.env"
  after="$(sha256sum <"$dir/app.env")"
  if run "$dir"; then check "refuses half a pair or an empty key" false; else check "refuses half a pair or an empty key" true; fi
  check "leaves half a pair unchanged" [ "$(sha256sum <"$dir/app.env")" = "$after" ]
done

# A key in any other form Compose reads (leading whitespace, export, spaces or a colon around the separator) is a key
# already there: refused and left as it is, so no second pair overrides the one the devices use.
n=0
TAB="$(printf '\t')"
public="$(random_b64url 87)"
private="$(random_b64url 43)"
for form in "  MAANE_VAPID_PUBLIC_KEY=$public" "${TAB}MAANE_VAPID_PRIVATE_KEY=$private" \
  "MAANE_VAPID_PUBLIC_KEY = $public" "MAANE_VAPID_PRIVATE_KEY =$private" "MAANE_VAPID_PUBLIC_KEY: $public" \
  "export MAANE_VAPID_PUBLIC_KEY=$public" "  export${TAB}MAANE_VAPID_PRIVATE_KEY = $private" \
  "export MAANE_VAPID_PUBLIC_KEY=$public
export MAANE_VAPID_PRIVATE_KEY=$private"; do
  n=$((n + 1))
  dir="$(new_dir)"
  printf '%s\n' "$form" >>"$dir/app.env"
  after="$(sha256sum <"$dir/app.env")"
  if run "$dir"; then check "refuses a key in another form ($n)" false; else check "refuses a key in another form ($n)" true; fi
  check "leaves a key in another form unchanged ($n)" [ "$(sha256sum <"$dir/app.env")" = "$after" ]
done

# A comment, or another name that starts the same, is not a key: the pair is added.
for other in "# MAANE_VAPID_PUBLIC_KEY=" "MAANE_VAPID_PUBLIC_KEY_OLD=$public"; do
  dir="$(new_dir)"
  printf '%s\n' "$other" >>"$dir/app.env"
  check "adds the pair next to a comment or another name" run "$dir"
  check "one public key next to a comment or another name" [ "$(count "$dir" MAANE_VAPID_PUBLIC_KEY)" = 1 ]
done

# A generator that fails or prints something else changes nothing.
for GENERATOR in fail odd; do
  dir="$(new_dir)"
  after="$(sha256sum <"$dir/app.env")"
  if run "$dir"; then check "refuses a failed generator ($GENERATOR)" false; else check "refuses ($GENERATOR)" true; fi
  check "unchanged after a failed generator ($GENERATOR)" [ "$(sha256sum <"$dir/app.env")" = "$after" ]
done
GENERATOR=pair

# An app.env that is not owner-only, or not there, is refused.
dir="$(new_dir)"
chmod 644 "$dir/app.env"
if run "$dir"; then check "refuses an app.env that is not mode 600" false; else check "refuses mode 644" true; fi
check "no key added to a file that is not mode 600" [ "$(count "$dir" MAANE_VAPID_PUBLIC_KEY)" = 0 ]
dir="$(mktemp -d "$WORK/empty.XXXXXX")"
if run "$dir"; then check "refuses a missing app.env" false; else check "refuses a missing app.env" true; fi
check "creates no app.env" [ ! -e "$dir/app.env" ]

echo "stack env tests: $PASSED passed, $FAILED failed"
[ "$FAILED" = 0 ]
