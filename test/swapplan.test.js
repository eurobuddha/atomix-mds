/* swapplan — grain-correct amount math + best-price-first sweep planner. */
(function () {
    var SP = AX.swapplan, O = AX.order;
    var NOTMINE = '0x' + '00'.repeat(64);   // a publicId whose signPk matches no maker → nothing excluded

    // ---- amount math (exact 6dp grain) ----
    T.eq('computeUsdt floor', SP.computeUsdt('4.95', 0.99), '4.9005');
    T.eq('computeMinima floor', SP.computeMinima('5', 1.01), '4.950495');
    T.eq('ceilUsdt rounds UP', SP.ceilUsdt('4.950495', 1.01), '5');
    T.eq('ceilUsdt whole', SP.ceilUsdt('100', 1), '100');
    T.eq('computeUsdt bad → null', SP.computeUsdt('0', 0.99), null);
    T.eq('computeMinima zero price → null', SP.computeMinima('5', 0), null);
    T.eq('legMinima grains to 6dp', SP.legMinima(4.9500001), '4.95');

    // pair(en, buy=ASK, sell=BID, min); effectiveBids uses sell, effectiveAsks uses buy.
    function mk(sk, bid, ask, min, mAvail, uAvail) {
        var o = O.make();
        o.signerPk = sk; o.mpk = sk + 'MPK'; o.eth = '0xE'; o.cid = '0xC';
        o.minimaAvail = mAvail; o.usdtAvail = uAvail;
        o.pairs.USDT = O.pair(true, ask || 0, bid || 0, min || 0);
        return o;
    }

    // ---- SELL sweep: fill best bid first, then the next ----
    var sellBook = { '0xAA': mk('0xAA', 1.00, 0, 0, 0, 100), '0xBB': mk('0xBB', 0.99, 0, 0, 0, 100) };
    var sp = SP.buildSweepPlan(sellBook, true, '150', 0, NOTMINE);
    T.eq('SELL sweep legs', sp.legs.length, 2);
    T.eq('SELL sweep filled 150', sp.filledMinima, 150);
    T.eq('SELL sweep totalUsdt 149.5', sp.totalUsdt, 149.5);
    T.eq('SELL sweep best-first (leg0 @1.00)', sp.legs[0].price, 1.00);
    T.eq('SELL sweep worst 0.99', sp.worstPrice, 0.99);
    T.ok('SELL sweep not partial', !sp.partial);

    // single-leg within one maker's cap
    var sp1 = SP.buildSweepPlan(sellBook, true, '50', 0, NOTMINE);
    T.eq('SELL single leg', sp1.legs.length, 1);
    T.eq('SELL single filled 50', sp1.filledMinima, 50);
    T.eq('SELL single usdt', sp1.legs[0].usdt, '50');

    // ---- BUY sweep with slippage cap: the 1.05 ask is beyond best×1.042 → excluded (partial) ----
    var buyBook = { '0xCC': mk('0xCC', 0, 1.00, 0, 100, 0), '0xDD': mk('0xDD', 0, 1.05, 0, 100, 0) };
    var bp = SP.buildSweepPlan(buyBook, false, '150', 0.042, NOTMINE);
    T.eq('BUY slippage: 1 leg only', bp.legs.length, 1);
    T.eq('BUY slippage: filled 100', bp.filledMinima, 100);
    T.eq('BUY slippage: partial', bp.partial, true);
    T.eq('BUY slippage: stopReason', bp.stopReason, 'slippage');
    T.eq('BUY slippage: pay 100', bp.legs[0].usdt, '100');

    // BUY with NO slippage cap fills both, paying ceil6(minima×ask) per leg
    var bp2 = SP.buildSweepPlan(buyBook, false, '150', 0, NOTMINE);
    T.eq('BUY nocap: 2 legs', bp2.legs.length, 2);
    T.eq('BUY nocap: filled 150', bp2.filledMinima, 150);
    T.eq('BUY nocap: total 152.5', bp2.totalUsdt, 152.5);

    // ---- below-min: target under the maker's min, nothing left to try → below-min, no legs ----
    var minBook = { '0xEE': mk('0xEE', 1.00, 0, 10, 0, 100) };
    var mp = SP.buildSweepPlan(minBook, true, '5', 0, NOTMINE);
    T.eq('below-min: no legs', mp.legs.length, 0);
    T.eq('below-min: reason', mp.stopReason, 'below-min');

    // ---- depth hint = whole fillable book (100 @1.00 + 100/0.99 @0.99 ≈ 201.010101) ----
    T.ok('sweepDepthMinima SELL ≈201.01', Math.abs(SP.sweepDepthMinima(sellBook, true, NOTMINE, 0) - 201.010101) < 1e-6);
})();
