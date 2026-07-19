/* market — the network-wide trade collector (MarketCollector port): price derivation, open-lock ingest,
   spent-lock reconciliation (EXECUTED via notify / REFUNDED past timelock / OPEN in the confirm window) —
   plus the maker backing clamp (trimAsks) and the inspect report builder. */
(function () {
    var MK = AX.market, DB = AX.swapdb, H = AX.htlc, O = AX.order;

    // ---- price ----
    T.eq('price = req/size', MK.price('5', '10'), 0.5);
    T.eq('price zero size → 0', MK.price('5', '0'), 0);
    T.eq('price garbage → 0', MK.price('xyz', '10'), 0);

    // ---- collector cycle over stubs ----
    var undo = [];
    function stub(o, n, f) { undo.push([o, n, o[n]]); o[n] = f; }
    function restore() { for (var i = undo.length - 1; i >= 0; i--) undo[i][0][undo[i][1]] = undo[i][2]; undo = []; }
    var HASH = '0x' + '77'.repeat(32);

    try {
        var upserts = [], executed = [], refunded = [];
        var openRows = [];
        stub(DB, 'upsertOpenTrade', function (t, cb) { upserts.push(t); cb && cb(null); });
        stub(DB, 'openTrades', function (cb) { cb(null, openRows.slice()); });
        stub(DB, 'markTradeExecuted', function (id, secret, cb) { executed.push({ id: id, secret: secret }); cb && cb(null); });
        stub(DB, 'markTradeRefunded', function (id, cb) { refunded.push(id); cb && cb(null); });
        var notifyResult = [];
        stub(H, 'scanNotifySecret', function (h, d, cb) { cb(null, notifyResult); });
        var scanCoins = [];
        stub(H, 'scanAllHtlcCoins', function (ca, d, cb) { cb(null, scanCoins); });

        // (1) a priced open lock is ingested; an unpriced coin is skipped
        scanCoins = [
            { coinid: '0xC1', tokenamount: '10', created: 500, state: { '0': '0xO', '1': '9.9', '2': '[ETH:x]', '3': '600', '4': '0xR', '5': HASH } },
            { coinid: '0xC2', tokenamount: '10', created: 500, state: { '1': 'garbage', '5': HASH } }
        ];
        MK.poll(510, function () { });
        T.eq('open lock ingested once', upserts.length, 1);
        T.eq('ingest price', upserts[0].price, 0.99);
        T.eq('ingest block/timelock', [upserts[0].createdBlock, upserts[0].timelock], [500, 600]);

        // (2) a previously-OPEN lock gone from the scan + notify present → EXECUTED with the secret
        scanCoins = [];
        openRows = [{ coinid: '0xC1', hash: HASH, timelock: 600 }];
        notifyResult = [{ state: { '100': '0xSEC', '101': HASH } }];
        MK.poll(510, function () { });
        T.ok('spent + notify → EXECUTED w/ secret', executed.length === 1 && executed[0].secret === '0xSEC');

        // (3) gone + NO notify + before timelock → stays OPEN (claim confirm window)
        executed = []; refunded = []; notifyResult = [];
        MK.poll(590, function () { });
        T.ok('no notify before timelock → left OPEN', executed.length === 0 && refunded.length === 0);

        // (4) gone + NO notify + PAST timelock → REFUNDED
        MK.poll(601, function () { });
        T.eq('past timelock → REFUNDED', refunded, ['0xC1']);
    } finally { restore(); }

    // ---- backing clamp: trimAsks semantics ----
    function pair3() { var p = O.pair(true, 0, 0, 0); p.asks = [O.level(1.0, 10), O.level(1.1, 10), O.level(1.2, 10)]; p.buy = 1.0; return p; }
    var p = pair3(); O.trimAsks(p, 2);
    T.eq('trimAsks keeps best-price prefix', p.asks.length, 2);
    p = pair3(); O.trimAsks(p, 0);
    T.ok('trim to zero ALSO clears the legacy scalar (no synthetic resurrect)', p.asks.length === 0 && p.buy === 0);

    // clampAsks: cumulative backing over combined coins; read-failure fails SAFE to 1
    var savedFree = H.myFreeCoins;
    try {
        var o = O.make(); o.pairs.USDT = pair3();
        H.myFreeCoins = function (tok, cb) { cb(null, [{ coinid: '0xA', tokenamount: '15' }, { coinid: '0xB', tokenamount: '7' }]); };
        AX.maker.clampAsks(o, function (r) {
            T.eq('clamp: 22 free backs 2 of the 10+10+10 ladder', r.pairs.USDT.asks.length, 2);
        });
        var o2 = O.make(); o2.pairs.USDT = pair3();
        H.myFreeCoins = function (tok, cb) { cb(new Error('node busy')); };
        AX.maker.clampAsks(o2, function (r) {
            T.eq('clamp: coin-read failure fails SAFE to the best tranche only', r.pairs.USDT.asks.length, 1);
        });
        var o3 = O.make(); var single = O.pair(true, 0, 0, 0); single.asks = [O.level(1.0, 10)]; o3.pairs.USDT = single;
        H.myFreeCoins = function () { throw new Error('must not be called for a single-tranche ladder'); };
        AX.maker.clampAsks(o3, function (r) { T.eq('clamp: single tranche skips the coin read', r.pairs.USDT.asks.length, 1); });
    } finally { H.myFreeCoins = savedFree; }

    // ---- inspect report builder (pure) ----
    var swap = { status: 'STARTED', role: 'INITIATOR', direction: 'MINIMA_TO_ERC20', sellAmount: '6.5', sellToken: 'mxUSDT',
        buyAmount: '6.435', buyToken: 'USDT', myTimelock: 999, myLegIsMinima: true, contractId: '0xCID' };
    var lines = AX.inspect.buildReport({ swap: swap, block: 100, secretKnown: true,
        myMin: { tokenamount: '6.5', state: { '3': '160' } }, cpMin: null, gc: null, events: [{ note: 'counterparty amount/token mismatch' }] });
    T.ok('report: header line', lines[0].indexOf('Sell 6.5 mxUSDT → 6.435 USDT') === 0);
    T.ok('report: my leg refundable w/ minutes', lines[1].indexOf('LOCKED — refundable at block 160 (~50 min)') > 0);
    T.ok('report: counterparty NOT FOUND yet', lines.some(function (l) { return l.indexOf('NOT FOUND yet') > 0; }));
    T.ok('report: secret known', lines.some(function (l) { return l === '• Secret: known (you can claim)'; }));
    T.ok('report: warning events surfaced', lines.some(function (l) { return l.indexOf('⚠') === 0; }));
    var done = AX.inspect.buildReport({ swap: Object.assign({}, swap, { status: 'COMPLETE' }), block: -1, secretKnown: true, myMin: null, cpMin: null, gc: null, events: [] });
    T.ok('report: complete has no patience note', !done.some(function (l) { return l.indexOf('swaps take a few minutes') > 0; }));
    T.ok('report: complete says claimed by counterparty', done.some(function (l) { return l.indexOf('claimed by the counterparty (complete)') > 0; }));
})();
