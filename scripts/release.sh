#!/usr/bin/env bash
# Interactive release: bump version, tag (with optional description), push.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

bold() { printf '\033[1m%s\033[0m' "$1"; }
die() { echo "Error: $*" >&2; exit 1; }

# ── preflight ────────────────────────────────────────────────────────────────
[[ -n "$(git status --porcelain)" ]] && die "working tree is not clean, commit or stash first"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git fetch --tags --quiet origin 2>/dev/null || echo "Warning: could not fetch tags from origin"

# Release candidates sort before their final release (v1.2.0-rc.1 < v1.2.0).
LAST_TAG="$(git -c versionsort.suffix=-rc tag --list 'v*' --sort=-v:refname | head -1)"
CUR_VER="$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' package.json | head -1)"

# Suggest next patch from the newest tag (or current version).
BASE="${LAST_TAG#v}"; BASE="${BASE%%-*}"; BASE="${BASE:-$CUR_VER}"
IFS=. read -r MA MI PA <<<"$BASE"
SUGGEST="$MA.$MI.$((PA + 1))"

echo
echo "  Branch:          $(bold "$BRANCH")"
echo "  Last release:    $(bold "${LAST_TAG:-none}")"
echo "  Current version: $(bold "$CUR_VER")"
echo

# ── version ──────────────────────────────────────────────────────────────────
read -r -p "New version [$SUGGEST]: " INPUT
SEMVER="${INPUT:-$SUGGEST}"
SEMVER="${SEMVER#v}"
[[ "$SEMVER" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$ ]] || die "version must be X.Y.Z or X.Y.Z-rc.N, got '$SEMVER'"
TAG="v$SEMVER"
# Files keep plain X.Y.Z: the Windows MSI refuses pre-release labels. CI marks -rc tags pre-release.
APP_VER="${SEMVER%%-*}"
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && die "tag $TAG already exists"
# Numeric sort key that puts X.Y.Z after its rcs: rc.N -> X.Y.Z.0.N, final -> X.Y.Z.1.0.
vkey() { local v="$1"; [[ "$v" == *-rc.* ]] && echo "${v%%-rc.*}.0.${v##*-rc.}" || echo "$v.1.0"; }
if [[ -n "$LAST_TAG" ]]; then
  NEWEST="$(printf '%s\n%s\n' "$(vkey "${LAST_TAG#v}")" "$(vkey "$SEMVER")" | sort -V | tail -1)"
  [[ "$NEWEST" == "$(vkey "$SEMVER")" && "${LAST_TAG#v}" != "$SEMVER" ]] || die "$SEMVER is not newer than $LAST_TAG"
fi

# ── description ──────────────────────────────────────────────────────────────
echo
echo "Release description (optional). Shown at the top of the release notes."
echo "Type lines, finish with an empty line. Leave empty to skip."
DESC=""
while IFS= read -r -p "> " LINE; do
  [[ -z "$LINE" ]] && break
  DESC+="${DESC:+$'\n'}$LINE"
done

# ── summary ──────────────────────────────────────────────────────────────────
echo
echo "────────────────────────────────────────────"
echo "  Version:  $(bold "$APP_VER")   Tag: $(bold "$TAG")$([[ "$SEMVER" == *-rc.* ]] && echo "   (pre-release)")"
if [[ -n "$DESC" ]]; then
  echo "  Description:"
  sed 's/^/    /' <<<"$DESC"
else
  echo "  Description: (none)"
fi
echo "  Commits since ${LAST_TAG:-start}:"
if [[ -n "$LAST_TAG" ]]; then
  git log --pretty=format:'    - %s' "$LAST_TAG..HEAD"; echo
else
  git log -20 --pretty=format:'    - %s'; echo
fi
echo "────────────────────────────────────────────"
[[ "$BRANCH" != "master" ]] && echo "Warning: you are on '$BRANCH', not master."
read -r -p "Bump, tag and push $TAG to origin? [y/N] " OK
[[ "$OK" =~ ^[Yy]$ ]] || { echo "Aborted, nothing changed."; exit 0; }

# ── bump ─────────────────────────────────────────────────────────────────────
sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"$APP_VER\"/" package.json
sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"$APP_VER\"/" src-tauri/tauri.conf.json
# only the first [package] version line
sed -i "0,/^version = \"[^\"]*\"/{s/^version = \"[^\"]*\"/version = \"$APP_VER\"/}" src-tauri/Cargo.toml
cargo update --manifest-path src-tauri/Cargo.toml --package cosmog 2>/dev/null || true

git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
# A later rc, or the final after its rcs, may find the version already bumped.
git diff --cached --quiet || git commit -m "chore: bump version to $TAG"

# Annotated tag carries the description; CI reads it into the release notes.
if [[ -n "$DESC" ]]; then
  git tag -a "$TAG" -m "$DESC"
else
  git tag "$TAG"
fi

git push origin HEAD
git push origin "$TAG"

echo
echo "Released $TAG. Watch the build: gh run list --workflow release.yml -L 1"
