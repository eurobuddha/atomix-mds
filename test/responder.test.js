/* responder — the fund-safety accept-guards (auto-lock ONLY if a take fits my ladder) + coin selection. */
(function () {
    var R = AX.responder, O = AX.order, D = AX.dec, EO = AX.ethops, TR = AX.trading;
    var USDT = TR.USDT_TOKENID;

    function mkOrder(bids, asks, min, en) {
        var o = O.make();
        var p = O.pair(en === false ? false : true, 0, 0, min || 0);
        p.bids = bids || []; p.asks = asks || [];
        o.pairs.USDT = p;
        return o;
    }
    // taker SELLS mxUSDT to me: coin carries the mxUSDT they locked (tokenamount) + the USDT they want (state[1]).
    function sellCoin(recvMinima, giveUsdt) { return { tokenamount: String(recvMinima), tokenid: USDT, state: { '1': String(giveUsdt) } }; }
    // taker BUYS mxUSDT from me: ETH contract with requestAmount (mxUSDT I give, 18dp) + amount (USDT I get, 6dp).
    function buyContract(giveMinima, recvUsdt) {
        return { requestAmount: D.parseUnits(String(giveMinima), 18), amount: D.parseUnits(String(recvUsdt), 6), tokenContract: EO.NET.usdt };
    }

    // ============ acceptTakerSellMinima: I BUY mxUSDT at my BID; accept only if I don't overpay ============
    var sellOrder = mkOrder([O.level(0.99, 100)], [], 1);   // bid 0.99, cap 100, min 1
    T.eq('sell: fits (49 ≤ 50×0.99=49.5)', R.acceptTakerSellMinima(sellOrder, sellCoin(50, 49)), true);
    T.eq('sell: exact at bid (49.5 ≤ 49.5)', R.acceptTakerSellMinima(sellOrder, sellCoin(50, 49.5)), true);
    T.eq('sell: would OVERPAY (50 > 49.5) → reject', R.acceptTakerSellMinima(sellOrder, sellCoin(50, 50)), false);
    T.eq('sell: over per-take cap (150 > 100) → reject', R.acceptTakerSellMinima(sellOrder, sellCoin(150, 100)), false);
    T.eq('sell: below min (0.5 < 1) → reject', R.acceptTakerSellMinima(sellOrder, sellCoin(0.5, 0.4)), false);
    T.eq('sell: disabled pair → reject', R.acceptTakerSellMinima(mkOrder([O.level(0.99, 100)], [], 1, false), sellCoin(50, 49)), false);
    T.eq('sell: null order → reject', R.acceptTakerSellMinima(null, sellCoin(50, 49)), false);
    // multi-tranche: a deeper (worse) bid can accept a larger take the top level can't
    var sellLadder = mkOrder([O.level(1.00, 40), O.level(0.98, 200)], [], 0);
    T.eq('sell ladder: 50 fits the 0.98/200 tranche', R.acceptTakerSellMinima(sellLadder, sellCoin(50, 49)), true);   // 49 ≤ 50×0.98=49
    T.eq('sell ladder: 50 @ 49.5 exceeds every tranche it fits', R.acceptTakerSellMinima(sellLadder, sellCoin(50, 49.5)), false); // >40 cap on lvl0; 49.5>49 on lvl1

    // ============ acceptTakerBuyMinima: I SELL mxUSDT at my ASK; accept only if I get enough USDT ============
    var buyOrder = mkOrder([], [O.level(1.01, 100)], 1);   // ask 1.01, cap 100, min 1
    T.eq('buy: fits (51 ≥ 50×1.01=50.5)', R.acceptTakerBuyMinima(buyOrder, buyContract(50, 51)), true);
    T.eq('buy: exact at ask (50.5 ≥ 50.5)', R.acceptTakerBuyMinima(buyOrder, buyContract(50, 50.5)), true);
    T.eq('buy: too little USDT (50 < 50.5) → reject', R.acceptTakerBuyMinima(buyOrder, buyContract(50, 50)), false);
    T.eq('buy: over cap (150 > 100) → reject', R.acceptTakerBuyMinima(buyOrder, buyContract(150, 200)), false);
    T.eq('buy: below min (0.5 < 1) → reject', R.acceptTakerBuyMinima(buyOrder, buyContract(0.5, 1)), false);
    // FUND-SAFETY (worthless-token drain): a non-USDT ERC20 as the paying leg must be rejected even if the numbers fit.
    function buyWorthless(giveMinima, recvAmt) { var c = buyContract(giveMinima, recvAmt); c.tokenContract = '0x000000000000000000000000000000000000dEaD'; return c; }
    T.eq('buy: worthless token rejected (even if amounts fit)', R.acceptTakerBuyMinima(buyOrder, buyWorthless(50, 2000)), false);

    // ============ selectCoins: largest-first, exact cover, MAX cap, can't-cover ============
    R._reset();
    function coins(list) { return list.map(function (a, i) { return { coinid: '0xC' + i, tokenamount: String(a) }; }); }
    var s1 = R._selectCoins(coins([10, 30, 20]), '45');
    T.eq('select: largest-first covers 45 with [30,20]', s1.ids.length, 2);
    T.eq('select: sum exact', s1.sum, '50');
    var s2 = R._selectCoins(coins([10, 20]), '45');
    T.eq('select: cannot cover → empty', s2.ids.length, 0);
    var s3 = R._selectCoins(coins([100]), '45');
    T.eq('select: single coin covers → 1 input', s3.ids.length, 1);
    // fractional exact accumulation (dec, not float)
    var s4 = R._selectCoins(coins(['4.95', '0.10']), '5');
    T.eq('select: fractional cover [4.95,0.10]=5.05', s4.sum, '5.05');
})();
