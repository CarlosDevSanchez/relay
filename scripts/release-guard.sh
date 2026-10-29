#!/bin/sh
# Release guard: the tag (vX.Y.Z) must equal package.json's version and its commit must be an ancestor of origin/main.
# Usage: scripts/release-guard.sh vX.Y.Z   (run from the repo root, with origin/main fetched)
set -eu
tag="${1:?usage: release-guard.sh vX.Y.Z}"
case "$tag" in v[0-9]*.[0-9]*.[0-9]*) ;; *) echo "bad tag: $tag" >&2; exit 1 ;; esac
git rev-parse -q --verify "refs/tags/$tag" >/dev/null || { echo "tag $tag not found" >&2; exit 1; }
pkg="$(node -p "require('./package.json').version")"
[ "${tag#v}" = "$pkg" ] || { echo "tag $tag does not match package.json version $pkg" >&2; exit 1; }
git merge-base --is-ancestor "$(git rev-list -n1 "$tag")" origin/main || { echo "$tag is not on origin/main" >&2; exit 1; }
echo "release guard OK: $tag"
