#!/usr/bin/env bash
# Builds dist/vocab-track-<version>.zip for the Chrome Web Store: tracked
# runtime files only, with a store variant of manifest.json. The repo's own
# manifest.json stays the unpacked dev manifest. Exits non-zero on any check.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

fail() { echo "package: $*" >&2; exit 1; }

VERSION=$(python3 -c 'import json; print(json.load(open("manifest.json"))["version"])') \
  || fail "cannot read version from manifest.json"
ZIP="$ROOT/dist/vocab-track-$VERSION.zip"

# Tracked files only, so untracked reference/ and the gitignored Cambridge
# lists never get a chance; then the allowlist of what the extension runs.
FILES=$(git ls-files | grep -E \
  '^([^/]+\.(js|html|css)|manifest\.json|LICENSE|NOTICE|lang/.*|fonts/.*|icons/.*|data/zh/.*|data/ko/.*|data/LICENSE)$')

# The guard behind the allowlist: none of these may ship, whatever the
# allowlist above grows into.
BAD=$(printf '%s\n' "$FILES" | grep -E \
  '^(tools|test|plans|docs|reference|01-brainstorm)/|^\.vibedoc|^data/(ielts-c1-c2|phrasal-verbs)\.json$')
[ -z "$BAD" ] || fail "forbidden path in the package:"$'\n'"$BAD"

# The zip is built from committed content, so a dirty packaged file means the
# zip would not match any commit.
DIRTY=$(printf '%s\n' "$FILES" | xargs git status --porcelain --)
[ -z "$DIRTY" ] || fail "uncommitted changes to packaged files:"$'\n'"$DIRTY"

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
printf '%s\n' "$FILES" | while IFS= read -r f; do
  mkdir -p "$STAGE/$(dirname "$f")" && cp "$f" "$STAGE/$f"
done

# Store variant: no nativeMessaging. The macOS capture host only knows the
# unpacked extension's ID (tools/install-macos.sh), and dashboard.js already
# tolerates the host being absent.
python3 - "$STAGE/manifest.json" <<'EOF' || fail "cannot rewrite the staged manifest"
import json, sys
p = sys.argv[1]
m = json.load(open(p))
m["permissions"] = [x for x in m["permissions"] if x != "nativeMessaging"]
# `key` only pins the unpacked build to the store item's ID, so the OAuth
# client (bound to that ID) works in development. The store keeps the ID
# itself and documents `key` as a development field.
m.pop("key", None)
json.dump(m, open(p, "w"), indent=2, ensure_ascii=False)
EOF

# Every file the zipped manifest names must be in the zip, or the store
# accepts a package Chrome then refuses to load.
MISSING=$(python3 - "$STAGE" <<'EOF'
import json, os, sys
root = sys.argv[1]
m = json.load(open(os.path.join(root, "manifest.json")))
paths = [m["background"]["service_worker"], m["side_panel"]["default_path"]]
paths += m.get("icons", {}).values()
paths += m.get("action", {}).get("default_icon", {}).values()
for cs in m.get("content_scripts", []):
    paths += cs.get("js", []) + cs.get("css", [])
for p in paths:
    if not os.path.isfile(os.path.join(root, p)):
        print(p)
EOF
)
[ -z "$MISSING" ] || fail "files named in manifest.json are missing:"$'\n'"$MISSING"
grep -q nativeMessaging "$STAGE/manifest.json" && fail "nativeMessaging is still in the zipped manifest"
grep -q '"key"' "$STAGE/manifest.json" && fail "key is still in the zipped manifest"

# Zip from inside the stage so manifest.json sits at the root of the zip;
# the store rejects one that does not.
mkdir -p "$ROOT/dist"
rm -f "$ZIP"
(cd "$STAGE" && zip -qrX "$ZIP" .) || fail "zip failed"

echo "$ZIP ($(du -h "$ZIP" | cut -f1 | tr -d ' '))"
