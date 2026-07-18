#!/bin/bash
# RELEASE GATE: run the crypto stack under the node's ACTUAL Rhino 1.7.14 (same engine + flags as service.js:
# ServiceJSRunner uses -version 200 (ES6) + optimization level -1). Node/V8 masks Rhino-only bugs, so this is the
# authoritative interop check for anything the background engine touches. Exits non-zero on any byte mismatch.
set -e
cd "$(dirname "$0")/.."

RHINO="${RHINO_JAR:-/Users/eurobuddha/Projects/Minima/lib/rhino-1.7.14.jar}"
if [ ! -f "$RHINO" ]; then echo "rhino jar not found at $RHINO (set RHINO_JAR)"; exit 2; fi

# Concatenate the load()-order into one script the Rhino shell evaluates, then the driver.
TMP="$(mktemp -t atomix_rhino).js"
trap 'rm -f "$TMP"' EXIT
for f in lib/rhino_shim.js \
         vendor/nacl.js vendor/blake.js vendor/sha256.js vendor/sha512.js vendor/sha3.js vendor/elliptic.js \
         lib/hex.js lib/flow.js crypto/ax_sodium.js crypto/ax_eth.js lib/identity.js lib/trading.js; do
  cat "$f" >> "$TMP"; echo ";" >> "$TMP"
done
# Rhino shell runs only ONE script file (extra args become arguments[]); load() the driver as the last statement.
echo 'load("test/rhino_driver.js");' >> "$TMP"

java -cp "$RHINO" org.mozilla.javascript.tools.shell.Main -version 200 -opt -1 "$TMP"
