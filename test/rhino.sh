#!/bin/bash
# RELEASE GATE: run the crypto stack under the node's ACTUAL Rhino 1.7.14 (same engine + flags as service.js:
# ServiceJSRunner uses -version 200 (ES6) + optimization level -1). Node/V8 masks Rhino-only bugs, so this is the
# authoritative interop check for anything the background engine touches. Exits non-zero on any byte mismatch.
#
# The load order is DERIVED from service.js's own MDS.load() lines (up to the first MDS-dependent module) so the
# gate always mirrors the real background-engine boot — a load-order drift (e.g. dropping the shim) fails here.
set -e
cd "$(dirname "$0")/.."

RHINO="${RHINO_JAR:-/Users/eurobuddha/Projects/Minima/lib/rhino-1.7.14.jar}"
if [ ! -f "$RHINO" ]; then echo "rhino jar not found at $RHINO (set RHINO_JAR)"; exit 2; fi

# 1) the shim MUST be service.js's first load (blake2b .fill / our .slice depend on it).
FIRST=$(grep -oE "MDS.load\('[^']+'\)" service.js | head -1 | sed "s/MDS.load('//;s/')//")
if [ "$FIRST" != "lib/rhino_shim.js" ]; then
  echo "GATE FAIL: service.js first load is '$FIRST', expected lib/rhino_shim.js"; exit 1
fi

# 2) build the concat from service.js's MDS.load order, up to (not incl.) the first MDS-dependent module (lib/mdsw.js).
TMP="$(mktemp -t atomix_rhino).js"
trap 'rm -f "$TMP"' EXIT
grep -oE "MDS.load\('[^']+'\)" service.js | sed "s/MDS.load('//;s/')//" | while read -r f; do
  case "$f" in lib/mdsw.js) break;; esac
  [ -f "$f" ] || { echo "GATE FAIL: service.js loads missing file $f" >&2; exit 1; }
  cat "$f" >> "$TMP"; echo ";" >> "$TMP"
done
# Rhino shell runs only ONE script file (extra args become arguments[]); load() the driver as the last statement.
echo 'load("test/rhino_driver.js");' >> "$TMP"

java -cp "$RHINO" org.mozilla.javascript.tools.shell.Main -version 200 -opt -1 "$TMP"
