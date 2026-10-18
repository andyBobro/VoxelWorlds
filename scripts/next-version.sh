#!/usr/bin/env bash
# Computes the next release version from git tags (tags are the source of truth).
# Run inside a clone with all tags fetched. Env:
#   PKG_VERSION  base version used for the very first release (no vX.Y.Z tag yet)
#   COMMIT_MSG   head commit message; "#major" / "#minor" select the bump (default patch)
#   BUMP_INPUT   optional explicit bump (patch|minor|major), e.g. from workflow_dispatch; wins over COMMIT_MSG
# Prints "version=X.Y.Z" and "tag=vX.Y.Z" lines (suitable for $GITHUB_OUTPUT).
set -euo pipefail

pkg="${PKG_VERSION:?PKG_VERSION is required}"
msg="${COMMIT_MSG:-}"
bump="${BUMP_INPUT:-}"

if [[ -z "$bump" ]]; then
  if [[ "$msg" == *"#major"* ]]; then bump=major
  elif [[ "$msg" == *"#minor"* ]]; then bump=minor
  else bump=patch; fi
fi
case "$bump" in patch|minor|major) ;; *) echo "invalid bump: $bump" >&2; exit 1 ;; esac

latest="$(git tag -l 'v[0-9]*.[0-9]*.[0-9]*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1 || true)"

if [[ -z "$latest" ]]; then
  [[ "$pkg" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "package.json version '$pkg' is not X.Y.Z" >&2; exit 1; }
  next="$pkg"
else
  IFS=. read -r major minor patch <<<"${latest#v}"
  case "$bump" in
    major) major=$((major + 1)); minor=0; patch=0 ;;
    minor) minor=$((minor + 1)); patch=0 ;;
    patch) patch=$((patch + 1)) ;;
  esac
  next="$major.$minor.$patch"
fi

if git rev-parse -q --verify "refs/tags/v$next" >/dev/null; then
  echo "tag v$next already exists" >&2
  exit 1
fi
if [[ -n "${CHECK_REMOTE:-}" ]] && git ls-remote --exit-code --tags origin "refs/tags/v$next" >/dev/null 2>&1; then
  echo "tag v$next already exists on origin" >&2
  exit 1
fi

echo "latest=${latest:-none} bump=$bump next=$next" >&2
echo "version=$next"
echo "tag=v$next"
