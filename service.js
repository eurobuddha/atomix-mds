/**
 * service.js — the AtomiX background engine (Rhino). Boots the crypto/identity stack + the TAKER settlement engine
 * (Phase 4): on every NEWBLOCK it drives my in-flight swaps to a terminal state — claim the mxUSDT leg / withdraw
 * the USDT leg with my secret, refund my expired legs, terminal status ONLY from the ETH contract flags (F1). The
 * maker keep-alive/responder + OTC land in Phases 5-6. Runs as long as the node runs (more reliable than Doze).
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
MDS.load('lib/decimal.js');       // exact BigInt decimal math (no deps) — engine amount quantisation
MDS.load('lib/abi.js');           // ABI encode/decode (needs ax_eth keccak) — ETH calldata
MDS.load('lib/ethhtlc.js');       // ETH HTLC interface (needs abi + sodium + hex + decimal)
MDS.load('lib/identity.js');
MDS.load('lib/trading.js');
MDS.load('lib/mds.js');
MDS.load('lib/ethrpc.js');         // ETH JSON-RPC over MDS.net.POST (needs mds)
MDS.load('lib/ethtx.js');          // legacy tx sign+send + nonce serializer (needs ethrpc + ax_eth + flow)
MDS.load('lib/ethops.js');         // ETH HTLC ops (needs ethhtlc + ethrpc + ethtx)
MDS.load('lib/swapdb.js');         // durable swap tables — boot.init() creates them (both hosts)
MDS.load('lib/htlc.js');
MDS.load('lib/prng.js');
MDS.load('lib/boot.js');
MDS.load('lib/settle.js');         // taker settlement engine (needs swapdb + htlc + ethops + dec + flow + trading)

var READY = false, CTX = null, POLLING = false;

function log(s) { MDS.log('[atomix] ' + s); }

/** One settlement pass; a guard prevents overlap if a slow ETH RPC read spans two ticks. */
function poll() {
    if (!READY || POLLING) return;
    POLLING = true;
    AX.settle.poll(function () { POLLING = false; });
}

MDS.init(function (msg) {
    if (msg.event === 'inited') {
        AX.boot.init(function (err, ctx) {
            if (err) { log('boot FAILED: ' + err.message); return; }
            CTX = ctx;
            // Configure the settlement engine: its own ETH RPC (separate from the UI's — a cross-instance nonce
            // clash on the shared seed-derived wallet is fund-SAFE, F1 recovers it with a fresh-pending retry).
            AX.settle.configure({
                rpc: new AX.ethrpc.Rpc(AX.ethops.NET.rpcs[0]),
                ethPriv: ctx.eth.privKey, ethAddr: ctx.eth.address,
                myMinimaPk: ctx.htlc.publickey, myMinimaAddr: ctx.htlc.miniaddress,
                notify: function (title, body) { MDS.notify(title + ': ' + body); },
                onSwapsChanged: function () { }   // service has no UI to refresh; the UI polls its own SQL
            });
            READY = true;
            log('booted — settlement engine live; ETH ' + ctx.eth.address + ' HTLC ' + ctx.htlc.address.slice(0, 16) + '…');
            poll();   // catch up any in-flight swaps immediately on (re)start
        });
    }
    else if (msg.event === 'NEWBLOCK') { poll(); }
    else if (msg.event === 'MDS_TIMER_60SECONDS') { poll(); }   // backstop between blocks
});
