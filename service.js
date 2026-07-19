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
MDS.load('lib/order.js');          // order model (responder reads my published ladder)
MDS.load('lib/prng.js');
MDS.load('lib/boot.js');
MDS.load('lib/settle.js');         // taker settlement engine (needs swapdb + htlc + ethops + dec + flow + trading)
MDS.load('lib/orderbook.js');      // publish/scan the shared order book (needs order + identity + sodium + mds)
MDS.load('lib/peg.js');            // price oracle + auto-MM ladder (needs order + trading + mds)
MDS.load('lib/responder.js');      // maker auto-responder (needs swapdb + htlc + ethops + dec + flow + trading + identity + order)
MDS.load('lib/maker.js');          // maker controller: build/publish/keep-alive/tombstone (needs order + orderbook + peg)

var READY = false, CTX = null, POLLING = false, RPC = null;

function log(s) { MDS.log('[atomix] ' + s); }

/** Fetch the maker's sellable balances (native minima sendable + ERC20 USDT balanceOf) for keep-alive publishing. */
function getBalances(cb) {
    MDS.cmd('balance tokenid:' + AX.trading.active().tokenId, function (r) {
        var minima = 0;
        try { minima = Number(r.response[0].sendable) || 0; } catch (e) { }
        AX.ethops.make(RPC, CTX.eth.privKey, CTX.eth.address).balanceOf(AX.ethops.NET.usdt, function (e, raw) {
            cb({ minima: minima, usdt: e ? 0 : Number(AX.dec.formatUnits(raw, 6)) });
        });
    });
}

/** One full pass: taker settlement + responder discovery (settle.poll), then maker peg-refresh + keep-alive.
 *  A guard prevents overlap if a slow ETH RPC read spans two ticks. */
function poll() {
    if (!READY || POLLING) return;
    POLLING = true;
    AX.settle.poll(function () {
        AX.maker.refreshPeg(function () {
            getBalances(function (avail) {
                AX.maker.keepAlive(avail, function () { POLLING = false; });
            });
        });
    });
}

MDS.init(function (msg) {
    if (msg.event === 'inited') {
        AX.boot.init(function (err, ctx) {
            if (err) { log('boot FAILED: ' + err.message); return; }
            CTX = ctx;
            RPC = new AX.ethrpc.Rpc(AX.ethops.NET.rpcs[0]);   // one ETH RPC shared by settle + responder + balances
            // Settlement engine (its own instance vs the UI's is fund-SAFE — F1 recovers a cross-instance nonce clash).
            AX.settle.configure({
                rpc: RPC, ethPriv: ctx.eth.privKey, ethAddr: ctx.eth.address,
                myMinimaPk: ctx.htlc.publickey, myMinimaAddr: ctx.htlc.miniaddress,
                notify: function (title, body) { MDS.notify(title + ': ' + body); },
                onSwapsChanged: function () { }   // service has no UI to refresh; the UI polls its own SQL
            });
            // Maker controller (build/publish/keep-alive/tombstone) + auto-responder. currentOrder() feeds the
            // responder its live ladder; both are inert until an order is configured + published.
            AX.maker.configure({
                identity: AX.boot.activeIdentity(ctx), myMinimaPk: ctx.htlc.publickey, ethAddr: ctx.eth.address,
                notify: function (title, body) { MDS.notify(title + ': ' + body); }, onOrder: function () { }
            });
            AX.responder.configure({
                rpc: RPC, ethPriv: ctx.eth.privKey, ethAddr: ctx.eth.address,
                myMinimaPk: ctx.htlc.publickey, myMinimaAddr: ctx.htlc.miniaddress,
                myIdentity: AX.boot.activeIdentity(ctx),
                getOrder: function () { return AX.maker.currentOrder(); },
                notify: function (title, body) { MDS.notify(title + ': ' + body); },
                onSwapsChanged: function () { }
            });
            AX.maker.loadConfig(function () {
                READY = true;
                log('booted — settlement + maker/responder live; ETH ' + ctx.eth.address);
                poll();   // catch up any in-flight swaps immediately on (re)start
            });
        });
    }
    else if (msg.event === 'NEWBLOCK') { poll(); }
    else if (msg.event === 'MDS_TIMER_60SECONDS') { poll(); }   // backstop between blocks
});
