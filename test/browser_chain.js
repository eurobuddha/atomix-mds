/*
 * BROWSER-CHAIN GATE — loads index.html's REAL script list, in order, into a jsdom window while simulating the
 * node's MDSFileHandler serving rules. This is the layer no other suite covers: run.js uses a vm sandbox with a
 * mocked global MDS, ui_render.js loads only the render subset — neither would have caught the 0.1.4 field bug
 * where the node HIJACKS any request for a file named "mds.js" (any path, case-insensitive —
 * MDSFileHandler.java:513/538) and serves its own canonical library, silently dropping our AX.mds wrapper.
 *
 * Asserts: every script loads; no OUR file (except the real root mds.js) trips a node special-case; the full AX
 * module set attaches; and AX.boot.init runs synchronously into the MDS XHR transport (not a sync throw).
 * Run: node test/browser_chain.js   (part of `npm test`)
 */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0, fails = [];
const ok = (n, c) => c ? pass++ : (fail++, fails.push(n));

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const srcs = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m => m[1]);
ok('index.html declares a script chain', srcs.length > 10);

// ---- the node's file-serving special-cases (from MDSFileHandler.java) ----
function nodeServes(reqPath) {
    if (reqPath.toLowerCase().endsWith('mds.js')) return 'mds.js';   // ANY *mds.js → the node's canonical library
    return reqPath;
}
// no file of OURS may collide with the hijack rule (the root mds.js IS the canonical library, that one is fine)
const collisions = srcs.filter(s => s !== 'mds.js' && nodeServes(s) !== s);
ok('no script filename collides with the node mds.js hijack: ' + (collisions.join(',') || 'none'), collisions.length === 0);

const dom = new JSDOM('<!DOCTYPE html><html data-theme="dark"><body><div id="root"></div></body></html>',
    { runScripts: 'outside-only', url: 'https://127.0.0.1:9003/0xUID/index.html?uid=0xUID' });
const w = dom.window, ctx = dom.getInternalVMContext();
const nc = require('crypto');
w.crypto = { getRandomValues: (a) => { nc.randomFillSync(a); return a; } };

let loadErrors = [];
for (const s of srcs) {
    const served = nodeServes(s);
    try { vm.runInContext(fs.readFileSync(path.join(ROOT, served), 'utf8'), ctx, { filename: s }); }
    catch (e) { loadErrors.push(s + ': ' + e.message); }
}
ok('every script executes clean: ' + (loadErrors.join(' | ') || 'all ok'), loadErrors.length === 0);

ok('window.MDS is the node library', typeof w.MDS === 'object' && typeof w.MDS.cmd === 'function');
// the BROWSER module set — settle + responder are deliberately service-only (settlement never runs in the page)
const MODULES = ['mds', 'boot', 'flow', 'hex', 'sodium', 'eth', 'trading', 'identity', 'htlc', 'swapdb', 'ethrpc',
    'ethtx', 'ethops', 'ethhtlc', 'abi', 'dec', 'prng', 'order', 'book', 'swapplan', 'peg', 'maker',
    'engine', 'otc', 'take', 'fmt', 'wallet', 'ui', 'app'];
const missing = MODULES.filter(m => !(w.AX && w.AX[m]));
ok('full AX module set attached: ' + (missing.join(',') || 'complete'), missing.length === 0);
ok('qrcode vendor global attached', vm.runInContext('typeof qrcode', ctx) === 'function');

// PARITY GUARD: no stub helper may exist or be called — a "coming later" button can never silently ship again.
const uiSrc = fs.readFileSync(path.join(ROOT, 'lib/ui.js'), 'utf8');
ok('no pending() stub in ui.js', !/pending\s*:\s*function|AX\.ui\.pending\(/.test(uiSrc));

// boot must run INTO the MDS transport (an async XHR), never die synchronously — the exact 0.1.4 failure shape.
let syncThrow = null;
try { w.AX.boot.init(function () { /* async result irrelevant here — jsdom has no node to answer */ }); }
catch (e) { syncThrow = e.message; }
ok('AX.boot.init reaches the MDS transport without a sync throw' + (syncThrow ? ' (threw: ' + syncThrow + ')' : ''), syncThrow === null);

console.log('\n' + (fail === 0 ? '✅ BROWSER CHAIN PASS' : '❌ BROWSER CHAIN FAIL') + ` — ${pass} passed, ${fail} failed`);
if (fail) { console.log(fails.join('\n')); process.exit(1); }
process.exit(0);   // exit before jsdom's void-XHR async error noise fires (boot's command has no node to talk to)
