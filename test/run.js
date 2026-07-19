/**
 * AtomiX-MDS test harness — loads the vendored globals + app modules into ONE isolated VM context that mimics the
 * Rhino/MDS environment (no require, no module, no Node built-ins beyond the primitives Rhino provides), then runs
 * every test file against it. This is the closest we can get to Rhino without a live node, and it asserts the
 * production modules (not the spike copies) reproduce the native interop vectors byte-for-byte.
 *
 * Run: node test/run.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// A minimal sandbox: the JS primitives Rhino exposes. Deliberately NO require / module / process / Buffer /
// TextEncoder / WebAssembly — if a module needs one of those it will fail here exactly as it would in Rhino.
const sandbox = {
    Uint8Array, Int8Array, Uint32Array, ArrayBuffer, DataView, Array, Object, Math, Date, JSON,
    Error, TypeError, RangeError, parseInt, parseFloat, isNaN, isFinite, String, Number, Boolean, Symbol,
    Map, Set, BigInt, Function, RegExp, encodeURIComponent, decodeURIComponent
};
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);

// Load order: vendored crypto globals, then hex, then the modules that depend on them.
const FILES = [
    'lib/rhino_shim.js',
    'vendor/nacl.js', 'vendor/blake.js', 'vendor/sha256.js', 'vendor/sha512.js', 'vendor/sha3.js', 'vendor/elliptic.js',
    'lib/hex.js', 'lib/flow.js', 'crypto/ax_sodium.js', 'crypto/ax_eth.js', 'lib/abi.js', 'lib/decimal.js', 'lib/identity.js', 'lib/trading.js',
    'lib/mds.js', 'lib/htlc.js', 'lib/prng.js', 'lib/order.js', 'lib/orderbook.js', 'lib/fmt.js', 'lib/ethhtlc.js',
    'lib/ethrpc.js', 'lib/ethtx.js', 'lib/ethops.js', 'lib/swapdb.js', 'lib/take.js', 'lib/swapplan.js', 'lib/engine.js', 'lib/settle.js', 'lib/peg.js', 'lib/responder.js'
];
for (const f of FILES) {
    try { vm.runInContext(read(f), ctx, { filename: f }); }
    catch (e) { console.error('LOAD FAILED (Rhino-incompatible?):', f, '\n', e); process.exit(1); }
}

// Wire a PRNG for seal() (Rhino/MDS supplies node-random; here we use Node crypto — same interface).
const nodeCrypto = require('crypto');
vm.runInContext('AX.sodium.setPRNG(__fill)', Object.assign(ctx, { __fill: (x, n) => { const b = nodeCrypto.randomBytes(n); for (let i = 0; i < n; i++) x[i] = b[i]; } }));

// Tiny assert kit exposed into the sandbox for the test files.
let pass = 0, fail = 0;
const fails = [];
sandbox.T = {
    eq: (name, got, want) => { const c = JSON.stringify(got) === JSON.stringify(want); c ? pass++ : (fail++, fails.push(name + '\n    got  ' + JSON.stringify(got) + '\n    want ' + JSON.stringify(want))); },
    ok: (name, cond) => { cond ? pass++ : (fail++, fails.push(name)); },
    log: (s) => console.log(s)
};
sandbox.VECTORS = JSON.parse(read('test/interop_vectors.json'));

// Run every *.test.js file inside the SAME context (so they see AX + T + VECTORS).
const testDir = path.join(ROOT, 'test');
for (const f of fs.readdirSync(testDir).filter((x) => x.endsWith('.test.js')).sort()) {
    console.log('\n### ' + f);
    try { vm.runInContext(read('test/' + f), ctx, { filename: 'test/' + f }); }
    catch (e) { fail++; fails.push('test file threw: ' + f + ' — ' + e); console.error(e); }
}

console.log('\n' + (fail === 0 ? '✅ ALL PASS' : '❌ FAILURES') + ` — ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n' + fails.join('\n')); process.exit(1); }
