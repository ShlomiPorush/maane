#!/usr/bin/env bash
# Plants each violation the guards look for in a scratch repository and checks that the guards fail on it
# and pass again once it is removed. Run inside the toolchain container (scripts/verify.sh does).
# Planted values are assembled at run time, so this file itself never matches a guard.
set -euo pipefail

GUARDS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/guards.sh"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
export CI=1 # the guards then print file and line only

git -C "$scratch" init -q
mkdir -p "$scratch/packages/shared/src/locales"
printf '{ "app": { "name": "Maane" } }\n' >"$scratch/packages/shared/src/locales/en.json"
printf '{ "app": { "name": "\xd7\x9e\xd7\xa2\xd7\xa0\xd7\x94" } }\n' >"$scratch/packages/shared/src/locales/he.json"
printf '* text=auto eol=lf\n' >"$scratch/.gitattributes"
git -C "$scratch" add -A

failures=0
guards_pass() { bash "$GUARDS" "$scratch" >/dev/null 2>&1; }

expect_pass() {
  guards_pass || {
    echo "FAIL: guards fail $1"
    bash "$GUARDS" "$scratch" || true
    failures=$((failures + 1))
  }
}

# Expects the guards to fail with a message that contains EXPECTED, so a violation is caught by the guard
# meant for it and not by another one by chance.
expect_failure() {
  local name="$1" expected="$2" out
  if out="$(bash "$GUARDS" "$scratch" 2>&1)"; then
    echo "FAIL: guards pass with $name"
    failures=$((failures + 1))
  elif ! grep -qF -- "$expected" <<<"$out"; then
    echo "FAIL: guards fail on $name, but without \"$expected\":"
    echo "$out"
    failures=$((failures + 1))
  else
    echo "ok: guards fail on $name"
  fi
}

# Plants a file with the given content, expects that failure, removes the file, expects a pass again.
plant() {
  local name="$1" expected="$2" path="$3" content="$4"
  mkdir -p "$(dirname "$scratch/$path")"
  printf '%s' "$content" >"$scratch/$path"
  expect_failure "$name" "$expected"
  rm -f "$scratch/$path"
  git -C "$scratch" rm -q --cached --ignore-unmatch "$path"
  expect_pass "after $name was removed"
}

repeat() { printf "%${2}s" "" | tr ' ' "$1"; }

expect_pass "on the clean scratch repository"

alef="$(printf '\xd7\x90')"
hebrew="Hebrew text is allowed only"
env_file="an environment file; keep only an example"
env_value="Example environment files must leave secrets"
secret="A secret-like value is in the repository"
plant "Hebrew outside he.json" "$hebrew" docs/note.md "Hello $alef"$'\n'
plant "Hebrew in another locale file" "$hebrew" packages/shared/src/locales/he.json.bak "$alef"$'\n'
plant "a literal right-to-left mark" "Write bidirectional control characters" README.md "$(printf 'a\xe2\x80\x8fb')"$'\n'
plant "a private IPv4 address" "IP addresses are not allowed" docs/hosts.md "host 10.$((1 + 1)).3.4"$'\n'
plant "a tracked environment file" "$env_file" .env "NAME="$'\n'
plant "a tracked environment file with a suffix" "$env_file" docker/env/server.env "NAME="$'\n'
plant "a secret value in an env example" "$env_value" .env.example "MAANE_AUTH_SECRETS=1:$(repeat a 32)"$'\n'
plant "a database URL in an env example" "$env_value" docker/env/server.env.example "DATABASE_URL=postgres://db"$'\n'
plant "a private key block" "$secret" docs/key.md "-----BEGIN ""RSA PRIVATE KEY-----"$'\n'
plant "a GitHub token" "$secret" src/a.ts "const t = \"gh""p_$(repeat a 36)\""$'\n'
plant "an SMTP2GO API key" "$secret" src/b.ts "const k = \"api""-$(repeat A 32)\""$'\n'
plant "credentials in a URL" "$secret" docs/db.md "postgres""://maane:$(repeat x 12)@db/maane"$'\n'
plant "build: in a Compose file" "must not contain build:" docker-compose.yml \
  $'services:\n  server:\n    build'":"$' .\n'
plant "a CRLF file" "Files must use LF line endings" docs/crlf.txt $'line\r\n'
plant "an action pinned to a tag" "Pin every action to a full commit SHA" .github/workflows/ci.yml \
  $'jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v'"7"$'\n'

# Locale key drift: the English file gets a key the Hebrew file lacks.
cp "$scratch/packages/shared/src/locales/en.json" "$scratch/en.json.orig"
printf '{ "app": { "name": "Maane", "extra": "x" } }\n' >"$scratch/packages/shared/src/locales/en.json"
expect_failure "a key only in en.json" "en.json and he.json must have the same keys"
mv "$scratch/en.json.orig" "$scratch/packages/shared/src/locales/en.json"
expect_pass "after the locale keys match again"

# A pinned action, a SHA-pinned Docker action and a local action pass.
mkdir -p "$scratch/.github/workflows"
printf 'jobs:\n  a:\n    steps:\n      - uses: actions/checkout@%s # v7\n      - uses: ./.github/actions/x\n' \
  "$(repeat a 40)" >"$scratch/.github/workflows/ok.yml"
expect_pass "on actions pinned to a commit SHA"
rm -f "$scratch/.github/workflows/ok.yml"

# shellcheck disable=SC2016 # the placeholder must stay literal
# Allowed forms pass: documentation addresses, an empty example, a placeholder URL, a version string.
printf 'Use 192.0.2.10 or 127.0.0.1. Version 1.2.3.4.5.\nDATABASE_URL=\npostgres://maane:${PASSWORD}@db\n' \
  >"$scratch/docs/allowed.md"
printf 'MAANE_AUTH_SECRETS=\nDATABASE_URL=\n' >"$scratch/.env.example"
expect_pass "on allowed addresses, empty examples and placeholders"

if [ "$failures" -gt 0 ]; then
  echo "$failures guard test(s) failed"
  exit 1
fi
echo "All guard tests passed"
