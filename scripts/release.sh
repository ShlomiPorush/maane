#!/usr/bin/env bash
# Releases a version: the release commit and tag, the image on GHCR, and the GitHub Release. Deploys
# nothing. Normally run by the Release workflow (.github/workflows/release.yml), which verifies the
# commit first; run by hand it runs scripts/verify.sh itself.
# Usage: scripts/release.sh --target ghcr --bump <patch|minor|major> [--skip-verify --expect-sha SHA] [--dry-run]
set -euo pipefail

# shellcheck source=scripts/lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

REGISTRY="ghcr.io/shlomiporush"
SOURCE_URL="https://github.com/ShlomiPorush/maane"
# Dockerfile name under docker/ and image name under REGISTRY.
DOCKERFILE="maane"
IMAGE="maane"
TARGET=""
BUMP=""
EXPECT_SHA=""
SKIP_VERIFY=0
DRY_RUN=0
RESUME=0
# One release at a time, also a run by hand next to the workflow: a ref on origin that only one run can create.
LOCK_REF="refs/maane/release-lock"
LOCK_COMMIT=""
SRC_DIR=""
VERSION=""
TAG=""

usage() {
  cat <<'EOF'
Usage: scripts/release.sh --target ghcr --bump <patch|minor|major> [--skip-verify --expect-sha SHA] [--dry-run]

  --target ghcr     Required. Publish the image to ghcr.io/shlomiporush/maane.
  --bump KIND       Required. Semantic version part to increase.
  --expect-sha SHA  Refuse unless main is exactly this commit (the one the workflow verified).
  --skip-verify     Do not run scripts/verify.sh. Only with --expect-sha.
  --dry-run         Run the preflight checks and print the plan. Runs no verification, builds nothing,
                    and changes nothing.

Steps: preflight (clean main in sync with origin, release notes present, version unused), full
scripts/verify.sh, version and changelog update, release commit and tag pushed together, the image
built from the tag and pushed, then :latest, then the GitHub Release from the CHANGELOG section.
When the newest tag has no GitHub Release yet, an earlier run stopped halfway: this run finishes that
version instead of starting a new one, reusing what is already published and refusing anything that
was not built from the tag. Needs docker with buildx, git and gh (logged in to GitHub and GHCR).
EOF
}

git_() { git -C "$REPO_ROOT" "$@"; }

image_ref() { echo "$REGISTRY/$IMAGE:$1"; }

# Reads the version from package.json content on stdin.
version_in() {
  sed -nE 's/^  "version": "([0-9]+\.[0-9]+\.[0-9]+)",$/\1/p' | head -1
}

next_version() {
  local major minor patch
  IFS=. read -r major minor patch <<<"$1"
  case "$BUMP" in
    major) echo "$((major + 1)).0.0" ;;
    minor) echo "$major.$((minor + 1)).0" ;;
    patch) echo "$major.$minor.$((patch + 1))" ;;
  esac
}

unreleased_notes() {
  awk '/^## \[Unreleased\]/ { on = 1; next } /^## \[/ { on = 0 } on && NF' "$REPO_ROOT/CHANGELOG.md"
}

# Prints the notes of one released version from CHANGELOG content on stdin. Fails unless the
# CHANGELOG has exactly one dated section for it, with at least one entry.
release_notes() {
  local version="$1" text count notes
  text="$(cat)"
  count="$(grep -cE "^## \[${version//./\\.}\] - [0-9]{4}-[0-9]{2}-[0-9]{2}$" <<<"$text" || true)"
  [ "$count" = 1 ] || die "CHANGELOG.md must have exactly one dated section for $version (found $count)"
  notes="$(awk -v head="## [$version] - " '
    index($0, head) == 1 { on = 1; next }
    on && /^## / { exit }
    on { lines[++n] = $0 }
    END {
      s = 1; while (s <= n && lines[s] ~ /^[[:space:]]*$/) s++
      e = n; while (e >= s && lines[e] ~ /^[[:space:]]*$/) e--
      for (i = s; i <= e; i++) print lines[i]
    }' <<<"$text")"
  grep -qvE '^[[:space:]]*(#.*)?$' <<<"$notes" || die "the CHANGELOG.md section for $version has no entries"
  printf '%s\n' "$notes"
}

# Prints "present" or "missing" for a GitHub Release. Any other failure stops the release.
release_state() {
  local out
  if out="$(gh release view "$1" --json tagName 2>&1)"; then
    echo present
  elif grep -qi "release not found" <<<"$out"; then
    echo missing
  else
    die "cannot read the GitHub Release $1: $out"
  fi
}

# Prints "missing", "match" (built from the given commit) or "other" for an image tag. A registry
# that cannot be read stops the release: it must never count as a free version.
image_state() {
  local ref="$1" revision="$2" out
  if ! out="$(docker buildx imagetools inspect "$ref" --format '{{json .Image}}' 2>&1)"; then
    if grep -qiE "not found|manifest unknown" <<<"$out"; then
      echo missing
      return
    fi
    die "cannot read $ref from the registry: $out"
  fi
  # The JSON comes indented; compare without white space.
  if grep -qF "\"org.opencontainers.image.revision\":\"$revision\"" <<<"$(tr -d '[:space:]' <<<"$out")"; then
    echo match
  else
    echo other
  fi
}

newest_tag() {
  git_ tag -l 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | head -1
}

preflight() {
  info "Preflight"
  require_docker
  command -v gh >/dev/null 2>&1 || die "gh (the GitHub CLI) is required"
  [ "$(git_ rev-parse --abbrev-ref HEAD)" = main ] || die "releases are made from main"
  [ -z "$(git_ status --porcelain)" ] || die "the working tree is not clean"
  git_ fetch --quiet --tags origin main
  local head
  head="$(git_ rev-parse HEAD)"
  [ "$head" = "$(git_ rev-parse origin/main)" ] || die "main is not in sync with origin/main"
  if [ -n "$EXPECT_SHA" ] && [ "$head" != "$EXPECT_SHA" ]; then
    die "main is at $head, not at the verified $EXPECT_SHA: something was pushed meanwhile. Start a new release run."
  fi

  local newest state
  newest="$(newest_tag)"
  if [ -n "$newest" ]; then
    state="$(release_state "$newest")"
    if [ "$state" = missing ]; then
      RESUME=1 TAG="$newest" VERSION="${newest#v}"
      git_ merge-base --is-ancestor "$TAG" HEAD || die "$TAG is not on main"
      [ "$(git_ show "$TAG:package.json" | version_in)" = "$VERSION" ] || die "package.json at $TAG is not $VERSION"
      echo "    $TAG was not finished: this run finishes it and ignores --bump $BUMP. Run again for the next version."
      return
    fi
  fi

  [ -n "$(unreleased_notes)" ] || die "CHANGELOG.md has no entries under [Unreleased]"
  local current
  current="$(version_in <"$REPO_ROOT/package.json")"
  [ -n "$current" ] || die "cannot read the version from package.json"
  VERSION="$(next_version "$current")"
  TAG="v$VERSION"
  # Tags are immutable: an existing tag (origin's were fetched above) is never moved or reused.
  git_ rev-parse -q --verify "refs/tags/$TAG" >/dev/null && die "tag $TAG already exists"
  state="$(image_state "$(image_ref "$VERSION")" none)"
  [ "$state" = missing ] || die "$(image_ref "$VERSION") is already published"
  echo "    $current -> $VERSION ($TAG)"
}

create_tag() {
  if [ $SKIP_VERIFY -eq 0 ]; then
    info "Full verification"
    "$REPO_ROOT/scripts/verify.sh"
  fi
  info "Updating version and changelog"
  sed -i -E "0,/^  \"version\": \"[0-9.]+\",$/s//  \"version\": \"$VERSION\",/" "$REPO_ROOT/package.json"
  sed -i "s/^## \[Unreleased\]$/## [Unreleased]\n\n## [$VERSION] - $(date -u +%Y-%m-%d)/" "$REPO_ROOT/CHANGELOG.md"
  release_notes "$VERSION" <"$REPO_ROOT/CHANGELOG.md" >/dev/null
  git_ add package.json CHANGELOG.md
  git_ commit --quiet -m "Release $TAG"
  git_ tag -a "$TAG" -m "$TAG"
  info "Pushing the release commit and $TAG"
  # Both or neither: a tag on origin is what a later run finishes. Never forced.
  git_ push --quiet --atomic origin HEAD:refs/heads/main "refs/tags/$TAG" ||
    die "pushing the release commit and $TAG failed, so nothing was published. Run the release again."
}

# Takes the release lock: pushes a commit made for this run to LOCK_REF, which git accepts only while the ref does not
# exist (--force-with-lease with an empty expected value). Another run, or a run that was killed, holds it otherwise.
# The commit message holds a random nonce: two runs on different machines with the same pid in the same second would
# otherwise make the same commit, and git reports a push of the commit a ref already holds as up to date.
take_lock() {
  local tree held
  tree="$(git_ hash-object -t tree -w /dev/null)"
  LOCK_COMMIT="$(git_ commit-tree "$tree" -m "Release lock: run ${GITHUB_RUN_ID:-by hand}, pid $$, at $(date -u +%Y-%m-%dT%H:%M:%SZ), nonce $(random_hex)")"
  if ! git_ push --quiet --force-with-lease="$LOCK_REF:" origin "$LOCK_COMMIT:$LOCK_REF"; then
    LOCK_COMMIT=""
    held="$(git_ ls-remote origin "$LOCK_REF" | cut -f1)"
    die "another release run holds $LOCK_REF (${held:-unknown}) on origin. Wait for it to finish.
       If no release runs (one was killed), read who took it with:
         git fetch origin $LOCK_REF && git log -1 FETCH_HEAD
       then remove that lock, and only that one, with:
         git push --force-with-lease=$LOCK_REF:${held:-<the commit above>} origin :$LOCK_REF"
  fi
}

# Removes the lock this run took, and nothing else: the lease names this run's commit.
cleanup() {
  [ -z "$SRC_DIR" ] || rm -rf "$SRC_DIR"
  if [ -n "$LOCK_COMMIT" ]; then
    git_ push --quiet --force-with-lease="$LOCK_REF:$LOCK_COMMIT" origin ":$LOCK_REF" ||
      echo "warning: could not remove $LOCK_REF on origin. If no release runs, remove this run's lock with:
  git push --force-with-lease=$LOCK_REF:$LOCK_COMMIT origin :$LOCK_REF" >&2
  fi
}

publish_image() {
  local revision src ref state
  revision="$(git_ rev-parse "$TAG^{commit}")"
  ref="$(image_ref "$VERSION")"
  src="$(mktemp -d)"
  SRC_DIR="$src"
  git_ archive "$TAG" | tar -x -C "$src"
  state="$(image_state "$ref" "$revision")"
  case "$state" in
    match) echo "    $ref is already published from $TAG" ;;
    other) die "$ref exists but was not built from $TAG; it is left as it is" ;;
    missing)
      info "Building and pushing $ref"
      docker buildx build --push --provenance=mode=max --sbom=true \
        -f "$src/docker/$DOCKERFILE.Dockerfile" --build-arg "VERSION=$VERSION" \
        --label "org.opencontainers.image.revision=$revision" \
        --label "org.opencontainers.image.source=$SOURCE_URL" \
        --label "org.opencontainers.image.version=$VERSION" \
        -t "$ref" "$src" || die "building or pushing $ref failed. Run the release again to finish $TAG."
      ;;
  esac
  state="$(image_state "$ref" "$revision")"
  [ "$state" = match ] || die "$ref is not the image built from $TAG"
  # :latest moves only once the version's image is there.
  info "Pointing $(image_ref latest) at $VERSION"
  docker buildx imagetools create --tag "$(image_ref latest)" "$ref" ||
    die "moving $(image_ref latest) failed. Run the release again to finish $TAG."
}

publish_release() {
  local notes state
  notes="$(mktemp)"
  git_ show "$TAG:CHANGELOG.md" | release_notes "$VERSION" >"$notes"
  info "Creating the GitHub Release $TAG"
  if ! gh release create "$TAG" --verify-tag --title "Maane $VERSION" --notes-file "$notes"; then
    # The request may have succeeded with its answer lost.
    state="$(release_state "$TAG")"
    [ "$state" = present ] || die "creating the GitHub Release $TAG failed. Run the release again to finish it."
    echo "    the GitHub Release $TAG exists"
  fi
  rm -f "$notes"
}

main() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --target)
        TARGET="${2:-}"
        shift
        ;;
      --bump)
        BUMP="${2:-}"
        shift
        ;;
      --expect-sha)
        EXPECT_SHA="${2:-}"
        shift
        ;;
      --skip-verify) SKIP_VERIFY=1 ;;
      --dry-run) DRY_RUN=1 ;;
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

  [ "$TARGET" = ghcr ] || die "an explicit target is required: --target ghcr"
  [[ "$BUMP" =~ ^(patch|minor|major)$ ]] || die "--bump must be patch, minor or major"
  [ -z "$EXPECT_SHA" ] || [[ "$EXPECT_SHA" =~ ^[0-9a-f]{40}$ ]] || die "--expect-sha must be a full commit SHA"
  [ $SKIP_VERIFY -eq 0 ] || [ -n "$EXPECT_SHA" ] || die "--skip-verify needs --expect-sha of the verified commit"

  trap cleanup EXIT
  # Before preflight, so the run that decides what to publish is the only one running.
  [ $DRY_RUN -eq 1 ] || take_lock
  preflight
  if [ $DRY_RUN -eq 1 ]; then
    if [ $RESUME -eq 1 ]; then
      info "Dry run. Would finish $TAG: the image if missing, :latest and the GitHub Release."
    else
      info "Dry run. Release notes for $TAG:"
      unreleased_notes | sed 's/^/    /'
      info "Would commit package.json and CHANGELOG.md, push them with $TAG, then publish:"
    fi
    echo "    $(image_ref "$VERSION") and :latest"
    return 0
  fi

  [ $RESUME -eq 1 ] || create_tag
  publish_image
  publish_release
  info "Released $TAG. Deploying is a separate step: see docs/deployment.md."
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
