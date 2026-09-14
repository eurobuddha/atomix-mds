/* visibility — history scoping: which recorded swaps belong on screen in the selected market (native
 * swap/SwapVisibility.java + TradingContext.forCoinLabel/forSwap). AtomiX trades ONE currency at a time over a
 * SHARED swap DB, so before this the Activity tab listed both markets at once — switching to MINIMA still
 * showed the dollar history. */
(function () {
    var TR = AX.trading;

    var NOW_MS = 1757000000000;                 // a fixed "now" — never Date.now()
    var NOW_SECS = Math.floor(NOW_MS / 1000);
    var TIP = 2400000;                          // a plausible Minima tip

    // ---- label -> market ----
    T.eq('forCoinLabel MINIMA', TR.forCoinLabel('MINIMA') === TR.MINIMA, true);
    T.eq('forCoinLabel mxUSDT', TR.forCoinLabel('mxUSDT') === TR.MXUSDT, true);
    // The dollar token is properly MxUSD; rows on disk say "mxUSDT". BOTH must attribute, so a later label
    // rename can never orphan the history already written under the old spelling.
    T.eq('forCoinLabel MxUSD alias', TR.forCoinLabel('MxUSD') === TR.MXUSDT, true);
    T.eq('forCoinLabel trims + ignores case', TR.forCoinLabel('  minima  ') === TR.MINIMA, true);
    // "USDT" is the ERC20 leg of EVERY swap in BOTH markets — matching it would attribute every row to the
    // dollar market and re-create the bug this map exists to fix.
    T.eq('forCoinLabel USDT is not a market', TR.forCoinLabel('USDT'), null);
    T.eq('forCoinLabel WETH is not a market', TR.forCoinLabel('WETH'), null);
    T.eq('forCoinLabel empty', TR.forCoinLabel(''), null);
    T.eq('forCoinLabel null', TR.forCoinLabel(null), null);

    T.eq('forSwap sells the minima leg', TR.forSwap('MINIMA', 'USDT') === TR.MINIMA, true);
    T.eq('forSwap buys the mxUSDT leg', TR.forSwap('USDT', 'mxUSDT') === TR.MXUSDT, true);
    T.eq('forSwap neither leg attributable', TR.forSwap('USDT', 'WETH'), null);

    // ---- the scoping rule ----
    function minimaSwap(status, timelock, minimaLeg) {
        return { hash: '0x' + '11'.repeat(32), selltoken: 'MINIMA', buytoken: 'USDT',
                 status: status, mytimelock: timelock, mylegminima: minimaLeg ? 1 : 0 };
    }
    function mxusdSwap(status) {
        return { hash: '0x' + '22'.repeat(32), selltoken: 'mxUSDT', buytoken: 'USDT',
                 status: status, mytimelock: TIP + 100, mylegminima: 1 };
    }
    function inMxusd(s) { return TR.visibleIn(s, TR.MXUSDT, TIP, NOW_MS); }

    // a swap always shows in its OWN market, whatever its state
    T.eq('own market complete shows', inMxusd(mxusdSwap('COMPLETE')), true);
    T.eq('own market refunded shows', inMxusd(mxusdSwap('REFUNDED')), true);
    T.eq('own market live shows', inMxusd(mxusdSwap('STARTED')), true);

    // an unattributable legacy row fails OPEN
    T.eq('unattributable row shows',
        inMxusd({ selltoken: 'USDT', buytoken: 'WETH', status: 'COMPLETE', mytimelock: 0, mylegminima: 0 }), true);

    // the other market: finished rows belong to THEIR history
    T.eq('other market complete hidden', inMxusd(minimaSwap('COMPLETE', TIP + 100, true)), false);
    T.eq('other market refunded hidden', inMxusd(minimaSwap('REFUNDED', TIP + 100, true)), false);
    T.eq('other market error hidden', inMxusd(minimaSwap('ERROR', TIP + 100, true)), false);

    // the other market: still-actionable rows pierce the filter (FUND SAFETY) — an in-flight MINIMA lock while
    // the user is in the dollar market MUST stay on screen; settlement is currency-agnostic and hiding a
    // claimable or refundable leg could cost real funds.
    T.eq('other market live pierces', inMxusd(minimaSwap('STARTED', TIP + 100, true)), true);
    T.eq('other market just-expired still shows through grace',
        inMxusd(minimaSwap('STARTED', TIP - TR.GRACE_BLOCKS + 1, true)), true);

    // the real case: a 20-Aug MINIMA lock still at "waiting" because its refund never reconciled into the DB.
    // Thousands of blocks past its timelock, it is not actionable from any screen — so it belongs in the MINIMA
    // history, not pinned to the dollar market forever.
    T.eq('long-dead other-market row is hidden', inMxusd(minimaSwap('STARTED', TIP - 40000, true)), false);

    // mylegminima=0 → mytimelock is unix SECONDS. Reading it as a block height would compare an epoch against
    // a block count and call every such swap live forever.
    T.eq('eth leg inside its seconds window', inMxusd(minimaSwap('LOCKED', NOW_SECS + 600, false)), true);
    T.eq('eth leg past its seconds window', inMxusd(minimaSwap('LOCKED', NOW_SECS - TR.GRACE_SECS - 1, false)), false);
    T.eq('eth leg inside the seconds grace', inMxusd(minimaSwap('LOCKED', NOW_SECS - TR.GRACE_SECS + 60, false)), true);

    // every unknown fails OPEN
    T.eq('no recorded deadline shows', inMxusd(minimaSwap('STARTED', 0, true)), true);
    T.eq('unknown chain tip shows',
        TR.visibleIn(minimaSwap('STARTED', TIP - 40000, true), TR.MXUSDT, 0, NOW_MS), true);
    T.eq('no active market shows everything',
        TR.visibleIn(minimaSwap('COMPLETE', TIP - 40000, true), null, TIP, NOW_MS), true);
})();
