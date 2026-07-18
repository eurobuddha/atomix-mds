/* Order model + order book: wire round-trip, tombstone/effective levels, freshest-per-signer, largest-cap routing,
   sign→verifyCoin (ports native OrderBookTombstoneTest + RoutingOrderTest). */
(function () {
    var O = AX.order, B = AX.book, ID = AX.identity, H = AX.hex;

    function liveOrder(signer, ts, priceBid, priceAsk, size, mAvail, uAvail) {
        var o = O.make(); o.signerPk = signer; o.ts = ts; o.minimaAvail = mAvail; o.usdtAvail = uAvail;
        var p = O.pair(true, priceAsk, priceBid, 0.01);
        if (priceAsk) p.asks.push(O.level(priceAsk, size));
        if (priceBid) p.bids.push(O.level(priceBid, size));
        o.pairs[O.SYM] = p; return o;
    }

    // ---- wire round-trip (buy=ASK / sell=BID inversion preserved) ----
    (function () {
        var o = liveOrder('0xAA', 123, 0.99, 1.01, 30, 500, 500);
        o.mpk = '0xMPK'; o.eth = '0xETH'; o.cid = '0xCID';
        var j = O.toJson(o);
        T.eq('bal m/u', [j.bal.m, j.bal.u], [500, 500]);
        T.eq('pair scalar buy=ASK', j.pairs.USDT.buy, 1.01);
        T.eq('pair scalar sell=BID', j.pairs.USDT.sell, 0.99);
        T.eq('asks in wire', j.pairs.USDT.asks[0], { p: 1.01, a: 30 });
        var back = O.fromJson(j);
        T.eq('round-trip ts', back.ts, 123);
        T.eq('round-trip usdtAvail', back.usdtAvail, 500);
        T.eq('round-trip bid', back.pairs.USDT.bids[0].p, 0.99);
    })();

    // ---- effective levels honor enable (tombstone = disabled pairs) ----
    (function () {
        var live = liveOrder('0xAA', 1, 0.99, 1.01, 30, 500, 500);
        T.ok('live has bids', O.effectiveBids(live, O.SYM).length > 0);
        T.ok('live has liquidity', O.hasLiquidity(live));
        live.pairs.USDT.en = false;   // tombstone
        T.eq('tombstone → no bids', O.effectiveBids(live, O.SYM).length, 0);
        T.eq('tombstone → no asks', O.effectiveAsks(live, O.SYM).length, 0);
        T.ok('tombstone → no liquidity', !O.hasLiquidity(live));
    })();

    // ---- non-finite balance clamp (0.1.7 parity) ----
    (function () {
        var o = O.fromJson({ mpk: '0x', ts: 1, bal: { m: 1e999, u: -5 }, pairs: {} });
        T.eq('Infinity minimaAvail clamped', o.minimaAvail, 0);
        T.eq('negative usdtAvail clamped', o.usdtAvail, 0);
    })();

    // ---- sanitize: sort + derive scalars + drop invalid ----
    (function () {
        var o = O.make(); var p = O.pair(true, 0, 0, 0.01);
        p.bids = [O.level(0.98, 5), O.level(0.99, 5), O.level(-1, 5)];  // out of order + invalid
        p.asks = [O.level(1.02, 5), O.level(1.01, 5)];
        o.pairs[O.SYM] = p; O.sanitize(o);
        T.eq('bids sorted desc + invalid dropped', o.pairs.USDT.bids.map(function (l) { return l.p; }), [0.99, 0.98]);
        T.eq('asks sorted asc', o.pairs.USDT.asks.map(function (l) { return l.p; }), [1.01, 1.02]);
        T.eq('derived best bid scalar', o.pairs.USDT.sell, 0.99);
        T.eq('derived best ask scalar', o.pairs.USDT.buy, 1.01);
    })();

    // ---- freshest-per-signer: a newer tombstone suppresses older live orders ----
    (function () {
        var book = {};
        var tomb = liveOrder('0xAA', 200, 0.99, 1.01, 30, 500, 500); tomb.pairs.USDT.en = false;
        B.mergeFreshest(book, tomb);
        B.mergeFreshest(book, liveOrder('0xAA', 100, 0.99, 1.01, 30, 500, 500));
        T.eq('freshest kept by ts', book['0xAA'].ts, 200);
        T.ok('freshest is the tombstone → no liquidity', !O.hasLiquidity(book['0xAA']));
        // distinct signer untouched
        B.mergeFreshest(book, liveOrder('0xBB', 50, 0.99, 1.01, 30, 500, 500));
        T.ok('other signer live', O.hasLiquidity(book['0xBB']));
    })();

    // ---- largest-cap-first routing at equal price (native RoutingOrderTest) ----
    (function () {
        var small = liveOrder('0xS', 1, 0.99, 0, 5, 0, 4.95);   // bid 0.99, usdt 4.95 → cap 5
        var big = liveOrder('0xB', 1, 0.99, 0, 30, 0, 29.7);    // bid 0.99, usdt 29.7 → cap 30
        var ls = O.effectiveBids(small, O.SYM)[0], lb = O.effectiveBids(big, O.SYM)[0];
        T.ok('deeper maker ranks first (sell)', B.compareForFill(big, lb, small, ls, true) < 0);
        // strictly better price beats bigger cap
        var hiSmall = liveOrder('0xH', 1, 1.00, 0, 0.5, 0, 0.5);
        var loBig = liveOrder('0xL', 1, 0.99, 0, 100, 0, 100);
        T.ok('higher bid first even tiny', B.compareForFill(hiSmall, O.effectiveBids(hiSmall, O.SYM)[0], loBig, O.effectiveBids(loBig, O.SYM)[0], true) < 0);
        // full sort via aggSide: best price then deepest
        var book = {}; book['0xS'] = small; book['0xB'] = big; book['0xH'] = hiSmall;
        var rows = B.aggSide(book, true, null);
        T.eq('rank0 best price 1.00', rows[0].level.p, 1.00);
        T.eq('rank1 deepest 0.99 (cap30)', rows[1].level.a, 30);
        T.eq('rank2 shallow 0.99 (cap5)', rows[2].level.a, 5);
    })();

    // ---- makerLive guard ----
    (function () {
        var live = liveOrder('0xAA', 1, 0.99, 1.01, 30, 500, 500);
        T.ok('live sell side', B.makerLive(live, true));
        T.ok('live buy side', B.makerLive(live, false));
        var tomb = liveOrder('0xAA', 1, 0.99, 1.01, 30, 500, 500); tomb.pairs.USDT.en = false;
        T.ok('tombstone blocked (sell)', !B.makerLive(tomb, true));
        T.ok('missing maker blocked', !B.makerLive(null, true));
    })();

    // ---- sign → verifyCoin round-trip + tamper rejection (interop verify path) ----
    (function () {
        var me = ID.fromSeed('maker-seed', 'usdtswap');
        var o = liveOrder('', 0, 0.99, 1.01, 30, 500, 500);
        // build the signed coin exactly like publish() does
        var msg = H.utf8(O.canonicalJson(o));
        var sig = AX.sodium.signDetached(msg, me.signSk);
        var coin = { coinid: '0xC0', state: { '1': '0x' + H.to(me.signPk), '2': '0x' + H.to(sig), '99': '0x' + H.to(msg) } };
        var v = B.verifyCoin(coin);
        T.ok('verifyCoin accepts a valid signed order', !!v);
        T.eq('verifyCoin sets signerPk', v && v.signerPk, '0x' + H.to(me.signPk));
        T.eq('verifyCoin parses the ladder', v && v.pairs.USDT.asks[0].p, 1.01);
        // tamper the order bytes → sig fails
        var badMsg = H.utf8(O.canonicalJson(liveOrder('', 0, 0.98, 1.01, 30, 500, 500)));
        var bad = { state: { '1': '0x' + H.to(me.signPk), '2': '0x' + H.to(sig), '99': '0x' + H.to(badMsg) } };
        T.ok('verifyCoin rejects tampered order', B.verifyCoin(bad) === null);
    })();
})();
