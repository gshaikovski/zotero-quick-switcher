#!/usr/bin/env bash
#
# Package the plugin into an installable .xpi.
#
# An .xpi is just a zip with manifest.json at the ROOT of the archive — not
# inside a subdirectory. Zipping the containing folder instead of its contents
# is the single most common way to produce an .xpi Zotero refuses to install.

set -euo pipefail

cd "$(dirname "$0")"

NAME="zotero-quick-switcher"
VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' manifest.json | head -1)"
OUT="build/${NAME}-${VERSION}.xpi"

rm -rf build
mkdir -p build

zip -q -r -X "$OUT" \
	manifest.json \
	bootstrap.js \
	prefs.js \
	src \
	skin \
	-x '*.DS_Store'

echo "Built $OUT"
unzip -l "$OUT"

# updates.json is what Zotero's "Check for Updates" reads (manifest update_url
# points at the copy on main). It is regenerated from manifest.json on every
# build, so commit it together with the version bump, and push it only AFTER
# the GitHub release exists -- otherwise update_link points at nothing.
field() { sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\\1/p" manifest.json | head -1; }
ID="$(field id)"
HOMEPAGE="$(field homepage_url)"
MIN="$(field strict_min_version)"
MAX="$(field strict_max_version)"
HASH="$(shasum -a 256 "$OUT" | cut -d' ' -f1)"

cat > updates.json <<JSON
{
	"addons": {
		"${ID}": {
			"updates": [
				{
					"version": "${VERSION}",
					"update_link": "${HOMEPAGE}/releases/download/v${VERSION}/${NAME}-${VERSION}.xpi",
					"update_hash": "sha256:${HASH}",
					"applications": {
						"zotero": {
							"strict_min_version": "${MIN}",
							"strict_max_version": "${MAX}"
						}
					}
				}
			]
		}
	}
}
JSON
echo "Wrote updates.json for ${VERSION}"
