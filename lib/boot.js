/**
 * boot — the shared init sequence used by BOTH index.html (browser) and service.js (Rhino). Wires the PRNG,
 * inits the kv table, loads the persisted currency, reads the node seed once, derives the per-currency comms
 * identities + the ETH address, and registers the HTLC covenant. Callback-based (Rhino-safe). Attaches to AX.boot.
 *
 * On success cb(null, ctx) where ctx = { identities:{minima,mxusdt}, eth:{privKey,address}, htlc:{...} }.
 * The seed is used only at derive time and never stored on ctx; the ETH privkey stays in memory only (never
 * persisted or logged), exactly like native.
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    var M = AX.mds, ID = AX.identity, TR = AX.trading, HT = AX.htlc, F = AX.flow, E = AX.eth, P = AX.prng, H = AX.hex;

    function init(cb) {
        var ctx = { identities: {}, eth: {}, htlc: null };
        F.waterfall([
            function (next) { P.init(function (err) { next(err); }); },
            function (next) { M.kvInit(function () { next(); }); },
            function (next) { M.kvGet('trading_currency', 'mxusdt', function (v) { TR.loadKey(v); next(); }); },
            // node seed (WRITE command — needs write permission). try/catch: an exception thrown inside an async
            // MDS callback is otherwise uncaught → the boot silently hangs (this is how R1 manifested on-device).
            function (next) {
                M.cmdR('vault action:seed', function (err, r) {
                    try {
                        if (err) return next(err);
                        var seed = (r && (r.seed || r.phrase));
                        if (!seed) return next(new Error('no seed from vault (node password-locked?)'));
                        ctx.identities.minima = ID.fromSeed(seed, TR.MINIMA.hkdfContext);
                        ctx.identities.mxusdt = ID.fromSeed(seed, TR.MXUSDT.hkdfContext);
                        next();   // seed used only here — never stored on ctx (reduces exposure surface)
                    } catch (e) { next(e); }
                });
            },
            // ETH bridge key (WRITE command) → address
            function (next) {
                M.cmdR('seedrandom modifier:ethbridge', function (err, r) {
                    try {
                        if (err) return next(err);
                        var sr = (r && r.seedrandom);   // node returns exactly `seedrandom`; no wrong-field fallback
                        if (!sr) return next(new Error('no seedrandom for ethbridge (node pending/locked?)'));
                        ctx.eth.privKey = sr.indexOf('0x') === 0 ? sr : '0x' + sr;
                        ctx.eth.address = E.addressFromPriv(ctx.eth.privKey);
                        next();
                    } catch (e) { next(e); }
                });
            },
            // register the HTLC covenant + pick the swap identity key
            function (next) { HT.setup(function (err, info) { if (err) return next(err); ctx.htlc = info; next(); }); }
        ], function (err) {
            cb(err || null, err ? null : ctx);
        });
    }

    /** The active currency's comms identity for the current selection. */
    function activeIdentity(ctx) { return ctx.identities[TR.active().key]; }

    AX.boot = { init: init, activeIdentity: activeIdentity };
})(typeof globalThis !== 'undefined' ? globalThis : this);
