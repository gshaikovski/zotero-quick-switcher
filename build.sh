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
