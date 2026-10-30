#!/usr/bin/env bash
#
# Cut a release: bump the version, test, build, commit, tag, publish the
# GitHub release, then push main.
#
#   ./release.sh X.Y.Z [notes-file]      (or: make release VERSION=X.Y.Z [NOTES=file])
#
# Without a notes file, GitHub generates notes from the commits since the last
# release.
#
# ORDER MATTERS: main is pushed LAST. Zotero's update check reads updates.json
# from main, so pushing it before the release exists would advertise a
# download link that 404s.

set -euo pipefail
cd "$(dirname "$0")"

NAME="zotero-quick-switcher"
VERSION="${1:-}"
NOTES="${2:-}"

die() { echo "release: $*" >&2; exit 1; }

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
	|| die "usage: ./release.sh X.Y.Z [notes-file]  (got '${VERSION}')"
TAG="v${VERSION}"
XPI="build/${NAME}-${VERSION}.xpi"
[[ -z "$NOTES" || -f "$NOTES" ]] || die "notes file not found: $NOTES"

# ---- preflight: refuse rather than half-release ---------------------------
command -v gh >/dev/null || die "gh (GitHub CLI) is not installed"
gh auth status >/dev/null 2>&1 || die "gh is not logged in (run: gh auth login)"
[[ "$(git rev-parse --abbrev-ref HEAD)" == main ]] || die "not on main"
[[ -z "$(git status --porcelain)" ]] || die "working tree is not clean"
git fetch -q origin main --tags
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] \
	|| die "main is not in sync with origin/main (pull or push first)"
git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null && die "tag ${TAG} already exists"
gh release view "$TAG" >/dev/null 2>&1 && die "GitHub release ${TAG} already exists"

OLD="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' manifest.json | head -1)"
echo "Releasing ${OLD} -> ${VERSION}"

# ---- bump, test, build -----------------------------------------------------
perl -pi -e "s/(\"version\"\\s*:\\s*\")[^\"]*\"/\${1}${VERSION}\"/" manifest.json
# The install instructions name the .xpi file, so keep them in step.
perl -pi -e "s/\Q${NAME}-${OLD}.xpi\E/${NAME}-${VERSION}.xpi/g" README.md STATUS.md

test/run.sh || die "tests failed — nothing committed (revert with: git checkout .)"
./build.sh >/dev/null
[[ -f "$XPI" ]] || die "build did not produce $XPI"

# ---- commit and tag locally -----------------------------------------------
git add manifest.json updates.json README.md STATUS.md
git commit -q -m "Release ${VERSION}"
git tag -a "$TAG" -m "Quick Switcher ${VERSION}"

# ---- publish: tag, then release, then main --------------------------------
trap 'echo "release: FAILED after the local commit/tag. Inspect, then either finish by hand
  (git push origin ${TAG}; gh release create ${TAG} ${XPI}; git push origin main)
or undo the local part (git tag -d ${TAG}; git reset --hard HEAD~1)." >&2' ERR

git push -q origin "$TAG"
if [[ -n "$NOTES" ]]; then
	gh release create "$TAG" "$XPI" --title "Quick Switcher ${VERSION}" --notes-file "$NOTES"
else
	gh release create "$TAG" "$XPI" --title "Quick Switcher ${VERSION}" --generate-notes
fi
git push -q origin main

trap - ERR
echo "Released ${TAG}; Zotero clients will now see ${VERSION} via Check for Updates."
