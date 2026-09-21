#!/usr/bin/env bash
# Regenerate src/assets/demo-canvas.png from the design prototype.
#
# This is a stopgap. The landing page is meant to embed the demo as a real
# interactive island (see docs/adr/0001) — until then the page shows this still.
#
# Two things make it fiddly, hence the script:
#
#  1. docs/design/site/*.dc.html reference ../support.js, ../globals.css and
#     ../_ds/, but those live one level deeper, under
#     docs/design/breakpoint-prototype/. The prototype cannot render where it
#     sits, so we assemble a tree where the paths resolve.
#  2. The mock only exists once the design tool's runtime has templated it, so
#     the capture needs a real browser with a virtual time budget, not a static
#     renderer.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
DESIGN="$REPO/docs/design"
OUT="$REPO/sites/web/src/assets/demo-canvas.png"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

if [[ ! -x "$CHROME" ]]; then
  echo "No Chrome at $CHROME. Set CHROME=/path/to/chrome and retry." >&2
  exit 1
fi

WORK="$(mktemp -d)"
cleanup() { /bin/rm -rf "$WORK"; }
trap cleanup EXIT

mkdir -p "$WORK/site"
cp "$DESIGN/breakpoint-prototype/support.js" "$WORK/support.js"
cp "$DESIGN/breakpoint-prototype/globals.css" "$WORK/globals.css"
cp -R "$DESIGN/breakpoint-prototype/_ds" "$WORK/_ds"
cp "$DESIGN/site/Breakpoint Demo.dc.html" "$WORK/site/demo.html"
cp "$DESIGN/site/site-tokens.css" "$WORK/site/site-tokens.css"

"$CHROME" --headless=new --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=2 --window-size=1280,800 \
  --virtual-time-budget=6000 --allow-file-access-from-files \
  --screenshot="$OUT" "file://$WORK/site/demo.html"

echo "Wrote $OUT"
