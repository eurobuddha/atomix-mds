#!/bin/bash
# Package the AtomiX MiniDapp into a versioned .mds.zip (excludes dev/test/vendor-source + git).
# Usage: ./build.sh   (version read from dapp.conf)
set -e
cd "$(dirname "$0")"
VER=$(grep -o '"version"[^,]*' dapp.conf | head -1 | sed 's/.*: *"//;s/"//')
OUT="AtomiX_${VER}.mds.zip"
rm -f "$OUT"
# Files shipped inside the MiniDapp. vendor/*.js are the bundled crypto (loaded by index.html + service.js).
zip -q -r "$OUT" \
    index.html service.js mds.js dapp.conf favicon.png \
    lib crypto vendor assets \
    -x '*/.*' -x '*.map'
echo "built $OUT ($(du -h "$OUT" | cut -f1))"
