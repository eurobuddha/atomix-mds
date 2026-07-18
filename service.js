/**
 * service.js — the AtomiX background engine (Rhino). Phase 1: loads the crypto/identity stack, boots the identity
 * (proving the no-WASM stack runs under Rhino on a live node), and stands up the tick loop. The settlement engine,
 * maker keep-alive, and OTC responder land in Phases 4-6. Runs as long as the node runs.
 */
MDS.load('lib/rhino_shim.js');   // MUST be first — polyfills Uint8Array.slice/.fill that Rhino lacks
MDS.load('vendor/nacl.js');
MDS.load('vendor/blake.js');
MDS.load('vendor/sha256.js');
MDS.load('vendor/sha512.js');
MDS.load('vendor/sha3.js');
MDS.load('vendor/elliptic.js');
MDS.load('lib/hex.js');
MDS.load('lib/flow.js');
MDS.load('crypto/ax_sodium.js');
MDS.load('crypto/ax_eth.js');
MDS.load('lib/identity.js');
MDS.load('lib/trading.js');
MDS.load('lib/mds.js');
MDS.load('lib/htlc.js');
MDS.load('lib/prng.js');
MDS.load('lib/boot.js');

var READY = false;
var CTX = null;

function log(s) { MDS.log('[atomix] ' + s); }

MDS.init(function (msg) {
    if (msg.event === 'inited') {
        AX.boot.init(function (err, ctx) {
            if (err) { log('boot FAILED: ' + err.message); return; }
            CTX = ctx; READY = true;
            log('booted — mxUSDT id ' + ctx.identities.mxusdt.publicId().slice(0, 18) + '… ETH ' + ctx.eth.address);
            log('Rhino crypto self-check: HTLC script registered @ ' + ctx.htlc.address.slice(0, 16) + '…');
        });
    }
    // Phase 1: just prove the tick fires. Phase 4 runs the settlement poll here.
    else if (msg.event === 'NEWBLOCK') { if (READY) { /* poll() — Phase 4 */ } }
    else if (msg.event === 'MDS_TIMER_60SECONDS') { if (READY) { /* discovery — Phase 4 */ } }
});
