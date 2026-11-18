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
    // ---- spread: the first rung of each side sits spread/2 from the mid, every further rung adds one step ----
    var os = mkOrder();
    P.applyPeg(os, { enable: true, step: 1, size: 10, bias: 0, levels: 3, spread: 3 });
    T.eq('spread 3%: offers at +1.5, +2.5, +3.5', os.pairs.USDT.asks.map(function (x) { return x.p; }), [1.015, 1.025, 1.035]);
    T.eq('spread 3%: bids at -1.5, -2.5, -3.5', os.pairs.USDT.bids.map(function (x) { return x.p; }), [0.985, 0.975, 0.965]);
    var o0 = mkOrder();
    P.applyPeg(o0, { enable: true, step: 1, size: 10, bias: 0, levels: 3, spread: 0 });
    T.eq('no spread: the ladder is as it always was (1, 2, 3 steps)', o0.pairs.USDT.asks.map(function (x) { return x.p; }), [1.01, 1.02, 1.03]);
    var ob = mkOrder();
    P.applyPeg(ob, { enable: true, step: 2, size: 10, bias: 0, levels: 2, spread: 999 });
    T.eq('spread is capped at 40% (first rungs at ±20%)', [ob.pairs.USDT.asks[0].p, ob.pairs.USDT.bids[0].p], [1.2, 0.8]);
    // ---- randomised sizes: whole numbers within +-rand % of the size, fixed by the seed, different per rung and side ----
    var sizesOf = function (seed, rand) { var o = mkOrder(); P.applyPeg(o, { enable: true, step: 1, askSize: 5000, bidSize: 5000, bias: 0, levels: 6, rand: rand, randSeed: seed }); return { a: o.pairs.USDT.asks.map(function (x) { return x.a; }), b: o.pairs.USDT.bids.map(function (x) { return x.a; }) }; };
    var z1 = sizesOf(7, 20), z2 = sizesOf(7, 20), z3 = sizesOf(8, 20), z0 = sizesOf(7, 0);
    T.eq('same seed, same sizes (a republish changes nothing)', z1, z2);
    T.eq('a new seed gives a new set', JSON.stringify(z1) !== JSON.stringify(z3), true);
    T.eq('rand 0: every rung exactly the size', z0.a.concat(z0.b), [5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000]);
    T.eq('all whole numbers within +-20%', z1.a.concat(z1.b).every(function (v) { return v === Math.round(v) && v >= 4000 && v <= 6000; }), true);
    T.eq('the rungs differ from each other', z1.a.filter(function (v, i, arr) { return arr.indexOf(v) === i; }).length > 2, true);
    T.eq('bids are not a mirror of the offers', JSON.stringify(z1.a) !== JSON.stringify(z1.b), true);
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
                if (url.indexOf('depth') >= 0) cb({ response: JSON.stringify({ bids: [['0.020', '10000']], asks: [['0.021', '10000']] }) });
                else cb({ response: '{}' });
            } } };
            var got = null;
            P.fetch(function (e, saved) { got = { e: e, saved: saved }; });
            T.ok('MEXC fetch ok', got && !got.e && got.saved);
            T.ok('MEXC mid ≈ 0.0205', Math.abs(got.saved.lastPrice - 0.0205) < 1e-9);
            // review 7 Nov: a +46 % read is HELD (no new price) and marks a jump pending → fresh() false, takes declined
            globalThis.MDS = { net: { GET: function (url, cb) {
                if (url.indexOf('depth') >= 0) cb({ response: JSON.stringify({ bids: [['0.0295', '10000']], asks: [['0.0305', '10000']] }) });
                else cb({ response: '{}' });
            } } };
            P._unpace();
            var got2 = null; P.fetch(function (e, saved) { got2 = { e: e, saved: saved }; });
            T.ok('a >3 % jump is held', got2 && !got2.saved);
            T.ok('jump pending', P.jumpPending() === true);
            T.ok('not fresh while it confirms', P.fresh() === false);
            P._reset();   // leave no pending jump behind for the later suites (shared sandbox)
        } finally { globalThis.MDS = savedMDS; TR.setActive(savedActive); }
    })();
})();
