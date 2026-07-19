/* peg — applyPeg ladder generation, widening factor, shouldReprice, armSafe, MEXC fetch. */
(function () {
    var P = AX.peg, O = AX.order, TR = AX.trading;

    function mkOrder() { var o = O.make(); o.pairs.USDT = O.pair(true, 0, 0, 0); o.usdtAvail = 1000; o.minimaAvail = 1000; return o; }

    // ---- applyPeg: off when disabled / unconfigured / stale ----
    P._reset();
    T.eq('applyPeg disabled → OFF', P.applyPeg(mkOrder(), { enable: false }).result, P.PEG_OFF);
    T.eq('applyPeg no step/size → OFF', P.applyPeg(mkOrder(), { enable: true, step: 0, size: 0 }).result, P.PEG_OFF);
    T.eq('applyPeg no price → STALE', P.applyPeg(mkOrder(), { enable: true, step: 1, size: 10 }).result, P.PEG_STALE);

    // ---- applyPeg fresh: 1-level ladder around a fresh mid=1.0, step 1%, bias 0 ----
    P._setPrice(1.0, 0);   // fresh
    var o1 = mkOrder();
    var r1 = P.applyPeg(o1, { enable: true, step: 1, size: 10, bias: 0, levels: 1 });
    T.eq('fresh → APPLIED', r1.result, P.PEG_APPLIED);
    T.eq('applied mid', r1.mid, 1.0);
    T.eq('ask = mid*(1+1%)', o1.pairs.USDT.asks[0].p, 1.01);
    T.eq('bid = mid*(1-1%)', o1.pairs.USDT.bids[0].p, 0.99);
    T.eq('ask size', o1.pairs.USDT.asks[0].a, 10);
    // sanitize re-derives the wire scalars from the best level (buy=ASK, sell=BID) for legacy scalar-only peers.
    T.eq('scalar mirrors best level (buy=ask, sell=bid)', [o1.pairs.USDT.buy, o1.pairs.USDT.sell], [1.01, 0.99]);

    // 3-level ladder + bias +2% shifts the quoted mid up
    var o2 = mkOrder();
    P.applyPeg(o2, { enable: true, step: 1, size: 5, bias: 2, levels: 3 });
    T.eq('3 levels each side', [o2.pairs.USDT.asks.length, o2.pairs.USDT.bids.length], [3, 3]);
    T.ok('bias shifts quoted mid up (~1.02)', Math.abs(o2.pairs.USDT.asks[0].p - 1.02 * 1.01) < 1e-9);

    // ---- widening: fresh 1×, ramps toward MAX_WIDEN when stale ----
    T.eq('wideningFactor fresh', P.wideningFactor(0), 1.0);
    T.eq('wideningFactor full-stale', P.wideningFactor(P.HARD_STALE_MS), P.MAX_WIDEN);
    // stale (age between FRESH and HARD) → PEG_WIDE with a widened spread
    P._setPrice(1.0, 30 * 60000);   // 30min stale
    var o3 = mkOrder();
    var r3 = P.applyPeg(o3, { enable: true, step: 1, size: 10, levels: 1 });
    T.eq('stale → WIDE', r3.result, P.PEG_WIDE);
    T.ok('stale spread wider than fresh 1%', o3.pairs.USDT.asks[0].p > 1.01);

    // past the hard ceiling → STALE (stop publishing)
    P._setPrice(1.0, P.HARD_STALE_MS + 60000);
    T.eq('past hard ceiling → STALE', P.applyPeg(mkOrder(), { enable: true, step: 1, size: 10 }).result, P.PEG_STALE);

    // ---- shouldReprice ----
    P._setPrice(1.0, 0);   // fresh
    T.eq('reprice: withdrawn+fresh → restore', P.shouldReprice({ enable: true, withdrawn: true }, 0), true);
    T.eq('reprice: was-wide+fresh → tighten', P.shouldReprice({ enable: true, wide: true }, 0), true);
    T.eq('reprice: within spam floor → no', P.shouldReprice({ enable: true, lastMid: 1.0, reprice: 1 }, Date.now()), false);
    T.eq('reprice: moved ≥ threshold → yes', P.shouldReprice({ enable: true, lastMid: 0.9, reprice: 1 }, 0), true);
    T.eq('reprice: moved < threshold → no', P.shouldReprice({ enable: true, lastMid: 1.0, reprice: 5 }, 0), false);
    P._setPrice(1.0, 30 * 60000);   // stale
    T.eq('reprice: stale → no (keep-alive handles it)', P.shouldReprice({ enable: true, lastMid: 0.5, reprice: 1 }, 0), false);

    // ---- armSafe: withdrawn → empty order (decline all) ----
    P._setPrice(1.0, 0);
    var live = mkOrder();
    T.ok('armSafe live → same order', P.armSafe(live, { enable: true, withdrawn: false }) === live);
    T.ok('armSafe withdrawn → empty', Object.keys(P.armSafe(live, { enable: true, withdrawn: true }).pairs).length === 0);

    // ---- fetch: parity currency stamps 1.0 ----
    (function () {
        var savedActive = TR.active();
        TR.setActive(TR.MXUSDT);   // parity
        P._reset();
        var got = null;
        P.fetch(function (e, saved) { got = { e: e, saved: saved }; });
        T.ok('parity fetch stamps 1.0', got && !got.e && got.saved && got.saved.lastPrice === 1.0);
        T.eq('parity → fresh', P.fresh(), true);
        TR.setActive(savedActive);
    })();

    // ---- fetch: MEXC depth via mocked MDS.net.GET ----
    (function () {
        var savedActive = TR.active(), savedMDS = globalThis.MDS;
        TR.setActive(TR.MINIMA);
        P._reset();
        try {
            globalThis.MDS = { net: { GET: function (url, cb) {
                if (url.indexOf('depth') >= 0) cb({ response: JSON.stringify({ bids: [['0.020', '2000']], asks: [['0.021', '2000']] }) });
                else cb({ response: '{}' });
            } } };
            var got = null;
            P.fetch(function (e, saved) { got = { e: e, saved: saved }; });
            T.ok('MEXC fetch ok', got && !got.e && got.saved);
            T.ok('MEXC mid ≈ 0.0205', Math.abs(got.saved.lastPrice - 0.0205) < 1e-9);
        } finally { globalThis.MDS = savedMDS; TR.setActive(savedActive); }
    })();
})();
