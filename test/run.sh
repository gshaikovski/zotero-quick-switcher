#!/usr/bin/env bash
# Run the offline test harnesses. These execute the plugin modules in node
# against stubs -- they do NOT require Zotero and never touch your profile.
set -uo pipefail
cd "$(dirname "$0")"
fail=0
for f in rank-harness overlay-harness fixes-harness review2-harness lifecycle-harness scale-harness sql-harness; do
	printf '%-18s ' "$f"
	out="$(node --expose-gc "$f.js" 2>&1)"
	if line="$(printf '%s' "$out" | grep -E '^[0-9]+/[0-9]+ passed')"; then
		echo "$line"
		printf '%s' "$out" | grep -q '^FAIL' && fail=1
	else
		echo "ERROR"; printf '%s\n' "$out"; fail=1
	fi
done
exit $fail
