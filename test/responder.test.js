// review 7 Nov: these suites drive the ETH-first lock path, which ships PAUSED (AX.htlc.ETH_FIRST_PAUSED) until HTLC v1.3
var __ethFirstWas = AX.htlc.ETH_FIRST_PAUSED; AX.htlc.ETH_FIRST_PAUSED = false;
var __xcheckWas = AX.settle && AX.settle.secondEndpointAgrees; if (AX.settle) AX.settle.secondEndpointAgrees = function (cid, c, cb) { cb(true); };   // this suite tests the lock logic, not the RPC cross-check
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
    // REGRESSION (live 2026-10-05): a take priced EXACTLY on the bid. 44.4×0.99 is exactly 43.956, but the old
    // DOUBLE product gave 43.955999999999996 — the gate silently declined the Fold's take every poll until it
    // refunded at timelock. The gate must now compare exactly.
    var incident = mkOrder([O.level(0.99, 5500)], [], 1);
    T.eq('sell: exactly-priced take accepted (44.4×0.99 = 43.956, float product rounds DOWN)',
        R.acceptTakerSellMinima(incident, sellCoin('44.4', '43.956')), true);
    T.eq('sell: one µUSDT over the exact price still rejects',
        R.acceptTakerSellMinima(incident, sellCoin('44.4', '43.956001')), false);

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
    // REGRESSION twin of the 2026-10-05 sell case, opposite rounding: 2.5×0.99 as a double is 2.4750000000000001,
    // so an exactly-priced 2.475 USDT payment used to FAIL the ≥ compare. Exact compare accepts it.
    var buyExact = mkOrder([], [O.level(0.99, 100)], 1);
    T.eq('buy: exactly-priced take accepted (2.5×0.99 = 2.475, float product rounds UP)',
        R.acceptTakerBuyMinima(buyExact, buyContract('2.5', '2.475')), true);

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

    // ============ HOSTILE on-chain state[1]: must DECLINE, never reach BigInt parsing (a throw inside the async
    // MDS callback chain would wedge the service poll loop forever — remote unauthenticated settlement DoS) ============
    T.eq('sell: non-numeric state[1] → reject (no throw)', R.acceptTakerSellMinima(sellOrder, sellCoin(50, 'xyz')), false);
    T.eq('sell: hex-garbage state[1] → reject', R.acceptTakerSellMinima(sellOrder, sellCoin(50, '0xdeadbeef')), false);
    T.eq('sell: negative state[1] → reject', R.acceptTakerSellMinima(sellOrder, sellCoin(50, '-5')), false);
    T.eq('sell: zero-request (malformed take) → reject', R.acceptTakerSellMinima(sellOrder, sellCoin(50, '0')), false);
    T.eq('sell: exponent form → reject (not plain decimal)', R.acceptTakerSellMinima(sellOrder, sellCoin(50, '1e2')), false);
    T.eq('sell: plain decimal still accepted', R.acceptTakerSellMinima(sellOrder, sellCoin(50, '49.00')), true);

    // ============ incoming buy-take queue: bounded (TTL prune + hard cap) so junk handshakes can't grow it forever ============
    R._reset();
    R.addIncoming('0x' + '31'.repeat(32));
    R.addIncoming('0x' + '32'.repeat(32));
    var inc = R._incoming();
    T.eq('incoming: entries queued with first-seen stamps', Object.keys(inc).length, 2);
    inc[Object.keys(inc)[0]].t = Date.now() - R.INCOMING_TTL_MS - 1000;   // backdate one past the TTL
    R.pruneIncoming();
    T.eq('incoming: stale entry pruned, fresh kept', Object.keys(R._incoming()).length, 1);
    R._reset();
    for (var qi = 0; qi < R.INCOMING_MAX + 10; qi++) R.addIncoming('0x' + ('h' + qi));   // cap check
    T.eq('incoming: hard cap holds (evict-oldest)', Object.keys(R._incoming()).length, R.INCOMING_MAX);
    T.ok('incoming: full queue keeps the NEWEST (junk cannot squat out fresh takes)', !!R._incoming()['h' + (R.INCOMING_MAX + 9)]);
    T.ok('incoming: the oldest was evicted', !R._incoming()['h0']);
    R.addIncoming('0x' + 'f1'.repeat(32), true);                                        // durable OTC re-arm bypasses the cap
    T.eq('incoming: force (OTC re-arm) bypasses the cap', Object.keys(R._incoming()).length, R.INCOMING_MAX + 1);
    R._reset();
})();

/* wallet keeper — merge before the safe coin read refuses (live 2026-10-26: 56 MxUSD coins declined every buy). */
(function () {
    var R = AX.responder, TR = AX.trading, MX = TR.USDT_TOKENID, ADDR = '0xAA';
    function bal(coins, sendable, unconf) { return { coins: coins, sendable: String(sendable), confirmed: String(sendable), unconfirmed: String(unconf || 0) }; }
    var m = R.keepPlan(bal(56, 21615.6), MX, ADDR);
    T.eq('keeper: 56 token coins → merge', m && m.kind, 'merge');
    T.eq('keeper: merge uses the native consolidate command', m.cmd, 'consolidate tokenid:' + MX + ' coinage:3 maxcoins:20 maxsigs:5');
    T.eq('keeper: 30 token coins is fine', R.keepPlan(bal(30, 500), MX, ADDR), null);
    T.eq('keeper: 31 token coins → merge', R.keepPlan(bal(31, 500), MX, ADDR).kind, 'merge');
    T.eq('keeper: MINIMA allows up to 120', R.keepPlan(bal(120, 9e5), '0x00', ADDR), null);
    T.eq('keeper: 121 MINIMA coins → merge', R.keepPlan(bal(121, 9e5), '0x00', ADDR).kind, 'merge');
    var s = R.keepPlan(bal(1, 500), MX, ADDR);
    T.eq('keeper: one coin → HALF of it split into 9 to myself (the change coin is the 10th)', s && s.cmd, 'send amount:250 address:0xAA tokenid:' + MX + ' split:9 coinage:3 mine:true');
    T.eq('keeper: the split names the address it must prove first', s.addr, '0xAA');
    T.eq('keeper: the half is truncated at 8dp, never rounded', R.keepPlan(bal(1, '10.123456789'), MX, ADDR).cmd.split(' ')[1], 'amount:5.06172839');
    T.eq('keeper: two coins is enough', R.keepPlan(bal(2, 500), MX, ADDR), null);
    T.eq('keeper: dust is never split', R.keepPlan(bal(1, 9), MX, ADDR), null);
    T.eq('keeper: no coins → nothing', R.keepPlan(bal(0, 0), MX, ADDR), null);
    T.eq('keeper: unconfirmed funds → wait (never act mid-settlement)', R.keepPlan(bal(56, 500, '0.5'), MX, ADDR), null);
    T.eq('keeper: no address → no split', R.keepPlan(bal(1, 500), MX, ''), null);

    // runner: one op at a time, never while a lock holds coins, rate-limited, next() never waits on the node.
    // 0.1.62: the commands go through AX.mds to a stand-in that reads them as the REAL node does (split on every ";",
    // trimmed, LAST duplicate parameter wins, send/consolidate refuse coinage < 3 with "Coinage MUST be >= 3"); the old
    // recorder accepted anything, so the keeper's `coinage:1` split (refused by every node) passed here.
    // 0.1.68: the stand-in also answers the ownership reads the split needs, shaped like the real node: `scripts
    // address:` throws "Script with that address not found" for an address the wallet does not hold (status:false), and
    // `keys action:list` returns {keys:[{publickey}], total}. Reads answer at once; signing commands are held.
    var PK = '0x' + 'C0'.repeat(32), OWNED = { '0XAA': { address: '0xAA', miniaddress: 'MxAA', simple: true, publickey: PK } };
    function realNode() {
        var n = { ran: [], held: [], refuse: null, keys: function () { return { keys: [{ publickey: PK }, { publickey: '0x' + 'D1'.repeat(32) }], total: 2 }; } };
        function trim(x) { return x.replace(/^[\u0000- ]+|[\u0000- ]+$/g, ''); }
        function parse(piece) {
            var toks = piece.split(/\s+/), verb = toks.shift().toLowerCase(), p = {};
            toks.forEach(function (t) { var i = t.indexOf(':'); if (i > 0) p[t.slice(0, i)] = t.slice(i + 1); });   // last one wins
            return { verb: verb, p: p };
        }
        n.cmd = function (q, cb) {
            var out = String(q).split(';').map(trim).filter(Boolean).map(function (piece) {
                var c = parse(piece); n.ran.push(piece);
                if (c.verb === 'scripts') {
                    var row = OWNED[String(c.p.address).toUpperCase()];
                    return row ? { status: true, response: row } : { status: false, error: 'Script with that address not found' };
                }
                if (c.verb === 'keys') { var k = n.keys(); return k ? { status: true, response: k } : { status: false, error: 'busy' }; }
                if ((c.verb === 'send' || c.verb === 'consolidate') && Number(c.p.coinage === undefined ? 3 : c.p.coinage) < 3)
                    return { status: false, error: 'Coinage MUST be >= 3' };
                if (n.refuse) return { status: false, error: n.refuse };
                return null;   // accepted: the reply is held until the test releases it (a txn in flight)
            });
            if (out[0]) cb(out[0]); else n.held.push(cb);
        };
        n.signing = function () { return n.ran.filter(function (x) { return /^(send|consolidate) /.test(x); }); };
        n.answer = function () { n.held.shift()({ status: true, response: { txpowid: '0x' + 'AB'.repeat(32) } }); };
        return n;
    }
    var H = AX.htlc, origBal = H.tokenBalance, savedMds = globalThis.MDS, node = realNode(), t = 1e12, balNow = bal(56, 21615.6), notes = [];
    H.tokenBalance = function (tok, cb) { cb(null, balNow); };
    globalThis.MDS = { cmd: node.cmd, log: function () {} };
    R._reset(); R._resetKeeper(); R._setNow(function () { return t; });
    R.configure({ myMinimaAddr: ADDR, notify: function (a, b) { notes.push(a + ' | ' + b); } });
    try {
        var nexts = 0; R.keepWallet(function () { nexts++; });
        T.eq('keeper run: merge reached the node', node.ran, ['consolidate tokenid:' + MX + ' coinage:3 maxcoins:20 maxsigs:5']);
        T.eq('keeper run: poll continues without waiting', nexts, 1);
        R.keepWallet(function () { nexts++; });
        T.eq('keeper run: no second op while one is in flight', node.ran.length, 1);
        node.answer();
        T.ok('keeper run: a posted merge is notified', notes.length === 1 && /^Merging/.test(notes[0]));
        t += 60000; R.keepWallet(function () { nexts++; });
        T.eq('keeper run: rate-limited for 2 minutes after an op', node.ran.length, 1);
        t += 61000; R.addIncoming('0x' + 'ab'.repeat(32));
        R._selectCoins([{ coinid: '0xC1', tokenamount: '5' }], '1');
        // one coin → the split: the node must ACCEPT it (old keeper: coinage:1 → "Coinage MUST be >= 3", every 2-3 min)
        balNow = bal(1, 500);
        R.keepWallet(function () { nexts++; });
        T.eq('keeper run: ownership proven first (scripts, then a complete key list), then the split with coinage:3', node.ran.slice(1),
            ['scripts address:' + ADDR, 'keys action:list', 'send amount:250 address:' + ADDR + ' tokenid:' + MX + ' split:9 coinage:3 mine:true']);
        T.eq('keeper run: the node accepted the split (reply in flight, not refused)', node.held.length, 1);
        node.answer();
        T.ok('keeper run: a posted split is notified', notes.length === 2 && /^Splitting/.test(notes[1]));
        // a refused op is quiet (log only, no notification) and backs off: 4 min after one failure, 8 after two
        node.refuse = 'Insufficient funds';
        t += 121000; R.keepWallet(function () {});
        T.eq('keeper run: acts again after the gap', node.signing().length, 3);
        T.eq('keeper run: a refused op raises no notification', notes.length, 2);
        t += 121000; R.keepWallet(function () {});
        T.eq('keeper run: after one failure the gap doubles (no retry at 2 min)', node.signing().length, 3);
        t += 120000; R.keepWallet(function () {});
        T.eq('keeper run: retried at 4 min', node.signing().length, 4);
        t += 241000; R.keepWallet(function () {});
        T.eq('keeper run: after two failures no retry at 4 min', node.signing().length, 4);
        t += 240000; R.keepWallet(function () {});
        T.eq('keeper run: retried at 8 min, still quiet', [node.signing().length, notes.length], [5, 2]);
        node.refuse = null; t += 961000; R.keepWallet(function () {}); node.answer();   // three failures: 16 min
        t += 121000; R.keepWallet(function () {});
        T.eq('keeper run: a success resets the gap to 2 min', node.signing().length, 7);
    } finally {
        while (node.held.length) node.answer();   // release the signing gate for the suites after this one
        H.tokenBalance = origBal; globalThis.MDS = savedMds; R._reset(); R._resetKeeper(); R._setNow(Date.now); R.configure(null);
    }

    // A1 (0.1.68): a split goes ONLY to an address the node is proven to own, right before the send.
    function splitRun(addr, tweak) {
        var nd = realNode(), logs = [];
        if (tweak) tweak(nd);
        H.tokenBalance = function (tok, cb) { cb(null, bal(1, 500)); };
        globalThis.MDS = { cmd: nd.cmd, log: function (x) { logs.push(x); } };
        R._reset(); R._resetKeeper(); R._setNow(function () { return 1e12; });
        R.configure({ myMinimaAddr: addr, notify: function () {} });
        try { R.keepWallet(function () {}); return { node: nd, logs: logs }; }
        finally { while (nd.held.length) nd.answer(); H.tokenBalance = origBal; globalThis.MDS = savedMds; R._reset(); R._resetKeeper(); R._setNow(Date.now); R.configure(null); }
    }
    var ok1 = splitRun('0xAA');
    T.eq('keeper proof: an owned address → the split is sent', ok1.node.signing(), ['send amount:250 address:0xAA tokenid:' + MX + ' split:9 coinage:3 mine:true']);
    var un = splitRun('0xBB');
    T.eq('keeper proof: an address the node has no script for → nothing sent', un.node.signing(), []);
    T.ok('keeper proof: … and it is logged with the full address', un.logs.some(function (l) { return /split failed .*not sent .*0xBB/.test(l); }));
    var kf = splitRun('0xAA', function (nd) { nd.keys = function () { return null; }; });
    T.eq('keeper proof: the keys read fails → nothing sent', kf.node.signing(), []);
    var inc = splitRun('0xAA', function (nd) { nd.keys = function () { return { keys: [{ publickey: PK }], total: 64 }; }; });
    T.eq('keeper proof: an incomplete key list (1 of 64) → nothing sent', inc.node.signing(), []);
    var gone = splitRun('0xAA', function (nd) { nd.keys = function () { return { keys: [{ publickey: '0x' + 'D1'.repeat(32) }], total: 1 }; }; });
    T.eq('keeper proof: the address key is not in a complete list (orphaned after a reseed) → nothing sent', gone.node.signing(), []);
    OWNED['0XCC'] = { address: '0xCC', miniaddress: 'MxCC', simple: false, publickey: PK };
    T.eq('keeper proof: a non-simple (script) address → nothing sent', splitRun('0xCC').node.signing(), []);

    // NIT (0.1.68): merge and split back off separately — a split the node keeps refusing never delays a merge
    (function () {
        var nd = realNode(), t2 = 2e12, b2 = bal(1, 500);
        H.tokenBalance = function (tok, cb) { cb(null, b2); };
        globalThis.MDS = { cmd: nd.cmd, log: function () {} };
        R._reset(); R._resetKeeper(); R._setNow(function () { return t2; });
        R.configure({ myMinimaAddr: '0xBB', notify: function () {} });   // unprovable → every split fails
        try {
            R.keepWallet(function () {}); t2 += 121000; R.keepWallet(function () {}); t2 += 241000; R.keepWallet(function () {});
            T.eq('keeper backoff: three failed splits, nothing sent', nd.signing(), []);
            b2 = bal(56, 500); t2 += 121000; R.keepWallet(function () {});
            T.eq('keeper backoff: a merge runs 2 min later despite the split backoff (8 min)', nd.signing(), ['consolidate tokenid:' + MX + ' coinage:3 maxcoins:20 maxsigs:5']);
        } finally { while (nd.held.length) nd.answer(); H.tokenBalance = origBal; globalThis.MDS = savedMds; R._reset(); R._resetKeeper(); R._setNow(Date.now); R.configure(null); }
    })();
})();
AX.htlc.ETH_FIRST_PAUSED = __ethFirstWas;
if (AX.settle) AX.settle.secondEndpointAgrees = __xcheckWas;
