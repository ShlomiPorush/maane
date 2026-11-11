#!/usr/bin/env bash
# Plants each violation the guards look for in a scratch repository and checks that the guard meant for it fails,
# and that the guards pass again once it is removed. Run inside the toolchain container (scripts/verify.sh does).
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
printf 'docs/private/\n' >"$scratch/.gitignore"
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
# meant for it and not by another one by chance. HIDDEN, when given, must not appear in the output (CI logs).
expect_failure() {
  local name="$1" expected="$2" hidden="${3:-}" out
  if out="$(bash "$GUARDS" "$scratch" 2>&1)"; then
    echo "FAIL: guards pass with $name"
    failures=$((failures + 1))
  elif ! grep -qF -- "$expected" <<<"$out"; then
    echo "FAIL: guards fail on $name, but without \"$expected\":"
    echo "$out"
    failures=$((failures + 1))
  elif [ -n "$hidden" ] && grep -qF -- "$hidden" <<<"$out"; then
    echo "FAIL: guards fail on $name, but repeat what they found in the output"
    failures=$((failures + 1))
  else
    echo "ok: guards fail on $name"
  fi
}

# Plants a file with the given content, expects that failure, removes the file, expects a pass again.
plant() {
  local name="$1" expected="$2" path="$3" content="$4" hidden="${5:-}"
  mkdir -p "$(dirname "$scratch/$path")"
  printf '%s' "$content" >"$scratch/$path"
  expect_failure "$name" "$expected" "$hidden"
  rm -f "$scratch/$path"
  git -C "$scratch" rm -q --cached --ignore-unmatch "$path"
  expect_pass "after $name was removed"
}

repeat() { printf "%${2}s" "" | tr ' ' "$1"; }

expect_pass "on the clean scratch repository"

alef="$(printf '\xd7\x90')"
hebrew="Hebrew text is allowed only"
bidi="Write bidirectional control characters"
env_file="an environment file; keep only an example"
env_value="Example environment files must leave secrets"
secret="A secret-like value is in the repository"
compose="Compose files must not build"
pinned="is not pinned to a full commit SHA"
token="gh""p_$(repeat a 36)"

plant "Hebrew outside he.json" "$hebrew" docs/note.md "Hello $alef"$'\n'
plant "Hebrew in another locale file" "$hebrew" packages/shared/src/locales/he.json.bak "$alef"$'\n'
plant "a literal right-to-left mark" "$bidi" README.md "$(printf 'a\xe2\x80\x8fb')"$'\n'
plant "a literal Arabic letter mark" "$bidi" README.md "$(printf 'a\xd8\x9cb')"$'\n'
printf 'x\000%s\n' "$token" >"$scratch/docs-binary.dat"
expect_failure "a binary file with a token after a NUL" "may be binary" "$token"
rm -f "$scratch/docs-binary.dat"
expect_pass "after the binary file was removed"
plant "a private IPv4 address" "IP addresses are not allowed" docs/hosts.md "host 10.$((1 + 1)).3.4"$'\n'
plant "an IPv4 address in the lockfile" "IP addresses are not allowed" pnpm-lock.yaml \
  "tarball: http://10.$((1 + 1)).3.4/x.tgz"$'\n'
plant "a tracked environment file" "$env_file" .env "NAME="$'\n'
plant "a tracked environment file with a suffix" "$env_file" docker/env/server.env "NAME="$'\n'
plant "a tracked .env.local" "$env_file" .env.local "NAME="$'\n'
plant "a secret value in an env example" "$env_value" .env.example "MAANE_AUTH_SECRETS=1:$(repeat a 32)"$'\n'
plant "a database URL in an env example" "$env_value" docker/env/server.env.example "DATABASE_URL=postgres://db"$'\n'
plant "a password in a .env.production.example" "$env_value" .env.production.example "POSTGRES_PASSWORD=x"$'\n'
plant "a private key block" "$secret" docs/key.md "-----BEGIN ""RSA PRIVATE KEY-----"$'\n'
plant "a GitHub token" "$secret" src/a.ts "const t = \"$token\""$'\n' "$token"
plant "an SMTP2GO API key" "$secret" src/b.ts "const k = \"api""-$(repeat A 32)\""$'\n'
plant "credentials in a URL" "$secret" docs/db.md "postgres""://maane:$(repeat x 12)@db/maane"$'\n'
plant "a URL password with a dollar sign" "$secret" docs/db.md "postgres""://maane:p""\$ss$(repeat x 8)@db/x"$'\n'
plant "build: in a Compose file" "$compose" docker-compose.yml $'services:\n  server:\n    build'":"$' .\n'
plant "a quoted build key" "$compose" docker-compose.yml $'services:\n  server:\n    "build"'":"$' .\n'
plant "build in a flow mapping" "$compose" docker/docker-compose-dev.example.yml \
  $'services: { server: { image: x, build'": . } }"$'\n'
plant "a CRLF file" "Files must use LF line endings" docs/crlf.txt $'line\r\n'
plant "an action pinned to a tag" "$pinned" .github/workflows/ci.yml \
  $'jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v'"7"$'\n'
plant "a quoted uses key" "$pinned" .github/workflows/ci.yml \
  $'jobs:\n  a:\n    steps:\n      - "uses": "actions/checkout@v'"7"$'"\n'
plant "a job that calls a workflow by tag" "$pinned" .github/workflows/call.yml \
  $'jobs:\n  a:\n    uses: owner/repo/.github/workflows/x.yml@main\n'
plant "a shellcheck finding" "SC2086" scripts/lib/bad.sh $'#!/usr/bin/env bash\necho $1\n'
plant "a badly formatted script" "Run: shfmt" scripts/lib/ugly.sh $'#!/usr/bin/env bash\nif true; then\necho ok\nfi\n'

# A script that is not executable.
mkdir -p "$scratch/scripts"
printf '#!/usr/bin/env bash\necho ok\n' >"$scratch/scripts/run.sh"
git -C "$scratch" add scripts/run.sh
git -C "$scratch" update-index --chmod=-x scripts/run.sh
expect_failure "a script without the executable bit" "is not executable"
git -C "$scratch" rm -q --cached scripts/run.sh
rm -f "$scratch/scripts/run.sh"
expect_pass "after the script was removed"

# The local deny list: a listed term fails, case-insensitively, and the output never repeats it in CI.
mkdir -p "$scratch/docs/private"
term="examplecorp$(repeat q 3)"
printf '# terms\n%s\n' "$term" >"$scratch/docs/private/deny-list.txt"
plant "a term from the deny list" "A term from docs/private/deny-list.txt" docs/about.md \
  "Made for ${term^^}."$'\n' "$term"
rm -rf "$scratch/docs/private"

# Locale key drift: the English file gets a key the Hebrew file lacks.
cp "$scratch/packages/shared/src/locales/en.json" "$scratch/en.json.orig"
printf '{ "app": { "name": "Maane", "extra": "x" } }\n' >"$scratch/packages/shared/src/locales/en.json"
expect_failure "a key only in en.json" "en.json and he.json must have the same keys"
mv "$scratch/en.json.orig" "$scratch/packages/shared/src/locales/en.json"
expect_pass "after the locale keys match again"

# Allowed forms pass: pinned, local and digest-pinned actions; documentation addresses; empty and quoted-empty
# examples; placeholder passwords in URLs; a version string; a binary image.
mkdir -p "$scratch/.github/workflows" "$scratch/docs" "$scratch/docker"
printf 'jobs:\n  a:\n    steps:\n      - uses: actions/checkout@%s # v7\n      - uses: ./.github/actions/x\n' \
  "$(repeat a 40)" >"$scratch/.github/workflows/ok.yml"
printf 'services:\n  server:\n    image: maane:dev\n' >"$scratch/docker/docker-compose-dev.example.yml"
# shellcheck disable=SC2016 # the placeholders must stay literal
printf '%s\n' 'Use 192.0.2.10 or 127.0.0.1. Version 1.2.3.4.5.' \
  'postgres://maane:${PASSWORD}@db postgres://maane:$PASSWORD@db postgres://maane:<password>@db' \
  'postgres://maane:***@db' >"$scratch/docs/allowed.md"
printf 'MAANE_AUTH_SECRETS=\nDATABASE_URL=""\nPOSTGRES_PASSWORD='"''"' # generated\n' >"$scratch/.env.example"
printf '\x89PNG\r\n\x1a\n\000\000' >"$scratch/docs/logo.png"
expect_pass "on allowed forms"

if [ "$failures" -gt 0 ]; then
  echo "$failures guard test(s) failed"
  exit 1
fi
echo "All guard tests passed"
