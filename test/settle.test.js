/* settle — taker settlement: amountTokenOk fund-gate, BUY claim, SELL withdraw+confirm, refund, retry window. */
(function () {
    var ST = AX.settle, DB = AX.swapdb, H = AX.htlc, EO = AX.ethops, TR = AX.trading;

    // ---- pure helpers ----
    T.eq('stripReqToken [ETH:x]', ST.stripReqToken('[ETH:0xdac17f958d2ee523a2206206994597c13d831ec7]'), '0xdac17f958d2ee523a2206206994597c13d831ec7');
    T.eq('stripReqToken [minima]', ST.stripReqToken('[minima]'), 'minima');
    T.eq('decimalsOf usdt', ST.decimalsOf(EO.NET.usdt), 6);
    T.eq('decimalsOf other', ST.decimalsOf('0x0000000000000000000000000000000000000001'), 18);
    // amountTokenOk: ≥ amount + right token
    T.eq('amountTokenOk sell ok', ST.amountTokenOk(['4.95', 'ETH:' + EO.NET.usdt], '5', EO.NET.usdt, true), true);
    T.eq('amountTokenOk sell locked-less', ST.amountTokenOk(['4.95', 'ETH:' + EO.NET.usdt], '4.9', EO.NET.usdt, true), false);
    T.eq('amountTokenOk sell wrong-token', ST.amountTokenOk(['4.95', 'ETH:' + EO.NET.usdt], '5', '0x0000000000000000000000000000000000000009', true), false);
    T.eq('amountTokenOk buy minima', ST.amountTokenOk(['4.95', 'minima'], '4.95', 'minima', false), true);

    // ---- stub/restore (settle captured module refs at load; mutate methods) ----
    var undo = [];
    function stub(o, n, f) { undo.push([o, n, o[n]]); o[n] = f; }
    function restore() { for (var i = undo.length - 1; i >= 0; i--) undo[i][0][undo[i][1]] = undo[i][2]; undo = []; }
    var HASH = '0x' + '22'.repeat(32);
    var USDT = TR.USDT_TOKENID;

    function baseDbStubs(swaps, secret, req, calls) {
        stub(DB, 'allSwaps', function (cb) { cb(null, swaps.slice()); });
        stub(DB, 'getSecret', function (h, cb) { cb(null, secret); });
        stub(DB, 'getRequest', function (h, cb) { cb(null, req); });
        stub(DB, 'hasEvent', function (h, ev, cb) { cb(null, false); });
        stub(DB, 'logEvent', function (h, ev, tok, amt, note, cb) { calls.push('log:' + ev + ':' + note); cb && cb(null); });
        stub(DB, 'setSwapStatus', function (h, s, cb) { calls.push('status:' + s); cb && cb(null); });
        stub(DB, 'getSwap', function (h, cb) { cb(null, { hash: h, status: 'STARTED', buyToken: 'USDT' }); });
    }
    function cfg() { ST._reset(); ST.configure({ rpc: { latestBlockTimestamp: function (cb) { cb(null, 2000000000); } },
        ethPriv: '0x' + '11'.repeat(32), ethAddr: '0xETH', myMinimaPk: '0xMYPK', myMinimaAddr: 'MxADDR',
        notify: function () {}, onSwapsChanged: function () {} }); }

    try {
        // ---------- BUY claim: maker's mxUSDT leg locked to me → claim with my secret → COMPLETE ----------
        cfg();
        var calls = [];
        baseDbStubs([{ hash: HASH, myLegIsMinima: false, status: 'STARTED' }], '0xSECRET', { reqAmount: '4.95', reqToken: 'minima' }, calls);
        var coin = { coinid: '0xC', tokenid: USDT, tokenamount: '4.95', state: { '0': '0xMAKER', '2': '[ETH:' + EO.NET.usdt + ']', '3': '999999', '4': '0xMYPK', '5': HASH } };
        stub(H, 'currentBlock', function (cb) { cb(null, 100); });
        stub(H, 'scanByHash', function (h, ca, d, cb) { cb(null, [coin]); });
        stub(H, 'scanByHashDeep', function (h, ca, d, cb) { cb(null, [coin]); });   // claim discovery is DEEP (0.1.17)
        stub(H, 'scanByKey', function (pk, ca, d, cb) { cb(null, []); });
        var claimed = null;
        stub(H, 'claim', function (c, h, s, addr, cb) { claimed = { h: h, s: s, addr: addr }; calls.push('claim'); cb(null, '0xTXP'); });
        stub(EO, 'make', function () { return { getContract: function (cid, cb) { cb(null, null); } }; });
        var done = false;
        ST.poll(function () { done = true; });
        T.ok('BUY poll completes', done);
        T.ok('BUY claim fired with my secret+addr', claimed && claimed.s === '0xSECRET' && claimed.addr === 'MxADDR');
        T.ok('BUY claim → CLAIMING then COMPLETE', calls.indexOf('status:CLAIMING') >= 0 && calls.indexOf('status:COMPLETE') >= 0 && calls.indexOf('claim') >= 0);
        restore();

        // ---------- claim BLOCKED when the maker locked LESS than I asked (amountTokenOk) ----------
        cfg();
        var c2 = [];
        baseDbStubs([{ hash: HASH, myLegIsMinima: false, status: 'STARTED' }], '0xSECRET', { reqAmount: '4.95', reqToken: 'minima' }, c2);
        var shortCoin = { coinid: '0xC', tokenid: USDT, tokenamount: '4.90', state: { '0': '0xMAKER', '2': '[minima]', '3': '999999', '4': '0xMYPK', '5': HASH } };
        stub(H, 'currentBlock', function (cb) { cb(null, 100); });
        stub(H, 'scanByHash', function (h, ca, d, cb) { cb(null, [shortCoin]); });
        stub(H, 'scanByHashDeep', function (h, ca, d, cb) { cb(null, [shortCoin]); });
        stub(H, 'scanByKey', function (pk, ca, d, cb) { cb(null, []); });
        stub(H, 'claim', function () { c2.push('claim'); });
        stub(EO, 'make', function () { return { getContract: function (cid, cb) { cb(null, null); } }; });
        ST.poll(function () {});
        T.ok('undersized lock → NO claim', c2.indexOf('claim') < 0);
        T.ok('undersized lock → mismatch logged', c2.some(function (x) { return x.indexOf('mismatch') >= 0; }));
        restore();

        // ---------- SELL withdraw: maker's ETH leg (receiver=me) → broadcast withdraw, status CLAIMING (not COMPLETE) ----------
        cfg();
        var c3 = [];
        baseDbStubs([{ hash: HASH, myLegIsMinima: true, status: 'STARTED' }], '0xSECRET', { reqAmount: '5', reqToken: 'ETH:' + EO.NET.usdt }, c3);
        stub(H, 'currentBlock', function (cb) { cb(null, 100); });
        stub(H, 'scanByHash', function (h, ca, d, cb) { cb(null, []); });
        stub(H, 'scanByKey', function (pk, ca, d, cb) { cb(null, []); });
        var withdrew = null;
        stub(EO, 'make', function () {
            return {
                getContract: function (cid, cb) { cb(null, { receiver: '0xeth', owner: '0xMAKER', amount: 5000000n, tokenContract: EO.NET.usdt, timelock: 3000000000, withdrawn: false, refunded: false }); },
                withdraw: function (cid, secret, cb) { withdrew = { cid: cid, secret: secret }; c3.push('withdraw'); cb(null, '0xETX'); }
            };
        });
        ST.poll(function () {});
        T.ok('SELL withdraw broadcast with secret', withdrew && withdrew.secret === '0xSECRET');
        T.ok('SELL withdraw → CLAIMING (terminal deferred to gc.withdrawn)', c3.indexOf('status:CLAIMING') >= 0 && c3.indexOf('status:COMPLETE') < 0);
        restore();

        // ---------- SELL confirm: gc.withdrawn=true → COMPLETE ----------
        cfg();
        var c4 = [];
        baseDbStubs([{ hash: HASH, myLegIsMinima: true, status: 'CLAIMING' }], '0xSECRET', null, c4);
        stub(H, 'currentBlock', function (cb) { cb(null, 100); });
        stub(H, 'scanByHash', function (h, ca, d, cb) { cb(null, []); });
        stub(H, 'scanByKey', function (pk, ca, d, cb) { cb(null, []); });
        stub(EO, 'make', function () { return { getContract: function (cid, cb) { cb(null, { receiver: '0xeth', owner: '0xMAKER', amount: 5000000n, withdrawn: true, refunded: false, timelock: 3000000000 }); } }; });
        ST.poll(function () {});
        T.ok('gc.withdrawn → COMPLETE', c4.indexOf('status:COMPLETE') >= 0);
        restore();

        // ---------- refund: my expired Minima lock (owner=me, block>timelock) → REFUNDED ----------
        cfg();
        var c5 = [];
        baseDbStubs([{ hash: HASH, myLegIsMinima: true, status: 'STARTED' }], '0xSECRET', null, c5);
        var myLock = { coinid: '0xC', tokenid: USDT, tokenamount: '4.95', state: { '0': '0xMYPK', '3': '50', '5': HASH } };
        stub(H, 'currentBlock', function (cb) { cb(null, 100); });   // block 100 > timelock 50
        stub(H, 'scanByHash', function (h, ca, d, cb) { cb(null, []); });
        stub(H, 'scanByKey', function (pk, ca, d, cb) { cb(null, [myLock]); });
        var refunded = null;
        stub(H, 'refund', function (c, addr, cb) { refunded = { addr: addr }; c5.push('refund'); cb(null, '0xTXP'); });
        stub(EO, 'make', function () { return { getContract: function (cid, cb) { cb(null, null); } }; });
        ST.poll(function () {});
        T.ok('expired lock → refund fired', refunded && refunded.addr === 'MxADDR');
        T.ok('refund → REFUNDED', c5.indexOf('status:REFUNDED') >= 0);
        restore();

        // ---------- refund must survive a post callback that NEVER arrives ----------
        // The old guard was a bare `inflight[key] = true` cleared only inside the callback, so one lost reply
        // wedged the refund forever. Cost a real 35.014005 MINIMA lock: refundable, polled every 30s, never sent.
        cfg();
        var c6 = [], clock = 1000000;
        ST._setNow(function () { return clock * 1000; });
        baseDbStubs([{ hash: HASH, myLegIsMinima: true, status: 'STARTED' }], '0xSECRET', null, c6);
        var deadLock = { coinid: '0xC', tokenid: USDT, tokenamount: '4.95', state: { '0': '0xMYPK', '3': '50', '5': HASH } };
        stub(H, 'currentBlock', function (cb) { cb(null, 100); });
        stub(H, 'scanByHash', function (h, ca, d, cb) { cb(null, []); });
        stub(H, 'scanByKey', function (pk, ca, d, cb) { cb(null, [deadLock]); });
        var tries = 0;
        stub(H, 'refund', function (c, addr, cb) { tries++; /* never calls back */ });
        stub(EO, 'make', function () { return { getContract: function (cid, cb) { cb(null, null); } }; });
        ST.poll(function () {});
        T.eq('lost-callback refund: first attempt fires', tries, 1);
        ST.poll(function () {});
        T.eq('lost-callback refund: same window does NOT re-sign', tries, 1);
        clock += 1000;                                   // well past ETH_RETRY_SECS
        ST.poll(function () {});
        T.eq('lost-callback refund: retries after the window', tries, 2);
        ST._setNow(function () { return Date.now(); });
        restore();

        // ---------- a lock older than the shallow scan is still found, via the DB-driven sweep ----------
        // scanByKey (HTLC_SCAN_DEPTH) returns nothing — exactly what happens once a coin is >256 blocks old.
        // The swap row still knows the leg and its timelock, so the refund must still happen.
        cfg();
        var c7 = [], deepArgs = null;
        baseDbStubs([{ hash: HASH, myLegIsMinima: true, status: 'STARTED', myTimelock: 50 }], '0xSECRET', null, c7);
        var oldLock = { coinid: '0xC', tokenid: USDT, tokenamount: '4.95', state: { '0': '0xMYPK', '3': '50', '5': HASH } };
        stub(H, 'currentBlock', function (cb) { cb(null, 2000); });     // 1950 blocks past the timelock
        stub(H, 'scanByHash', function (h, ca, d, cb) { cb(null, []); });
        stub(H, 'scanByKey', function (pk, ca, d, cb) { cb(null, []); });            // shallow scan is blind
        stub(H, 'scanByHashDeep', function (h, ca, d, cb) { deepArgs = { h: h, d: d }; cb(null, [oldLock]); });
        var deepRefund = null;
        stub(H, 'refund', function (c, addr, cb) { deepRefund = addr; cb(null, '0xTXP'); });
        stub(EO, 'make', function () { return { getContract: function (cid, cb) { cb(null, null); } }; });
        ST.poll(function () {});
        T.ok('sweep used the deep per-hash scan', deepArgs && deepArgs.h === HASH);
        T.eq('sweep scanned past the tree-shallow depth', deepArgs && deepArgs.d, 1024);
        T.ok('out-of-scan lock still refunded', deepRefund === 'MxADDR');
        T.ok('sweep refund → REFUNDED', c7.indexOf('status:REFUNDED') >= 0);
        restore();

        // ---------- the sweep must not touch a swap that is not yet refundable ----------
        cfg();
        var c8 = [], deepCalled = false;
        baseDbStubs([{ hash: HASH, myLegIsMinima: true, status: 'STARTED', myTimelock: 5000 }], '0xSECRET', null, c8);
        stub(H, 'currentBlock', function (cb) { cb(null, 2000); });     // still short of the timelock
        stub(H, 'scanByHash', function (h, ca, d, cb) { cb(null, []); });
        stub(H, 'scanByKey', function (pk, ca, d, cb) { cb(null, []); });
        stub(H, 'scanByHashDeep', function (h, ca, d, cb) { deepCalled = true; cb(null, []); });
        stub(EO, 'make', function () { return { getContract: function (cid, cb) { cb(null, null); } }; });
        ST.poll(function () {});
        T.ok('sweep skips a lock that is not yet refundable', deepCalled === false);
        restore();

        // ==================== RESPONDER-PERSPECTIVE settlement (the maker NEVER generates the secret) ====================
        // These lock in the two harvest paths (native SwapEngine:814 + :515/1208) — without them every filled maker
        // order strands past its timelock: the maker pays its counter-leg and can never claim/withdraw the other.

        // ---------- (R1) sell-take maker: taker withdrew my USDT revealing gc.preimage → harvest → NEXT poll claims ----------
        cfg();
        var r1 = [], secrets = {};
        var PREIMAGE = '0x' + 'ab'.repeat(32);
        stub(DB, 'allSwaps', function (cb) { cb(null, [{ hash: HASH, myLegIsMinima: false, status: 'LOCKED', buyToken: 'mxUSDT' }]); });
        stub(DB, 'getSecret', function (h, cb) { cb(null, secrets[h] || null); });
        stub(DB, 'insertSecret', function (h, s, cb) { if (!secrets[h]) secrets[h] = s; r1.push('harvest:' + s); cb(null); });
        stub(DB, 'getRequest', function (h, cb) { cb(null, null); });                    // responder has no myhtlc row
        stub(DB, 'hasEvent', function (h, ev, cb) { cb(null, false); });
        stub(DB, 'logEvent', function (h, ev, tok, amt, note, cb) { r1.push('log:' + ev); cb && cb(null); });
        stub(DB, 'setSwapStatus', function (h, s, cb) { r1.push('status:' + s); cb && cb(null); });
        stub(DB, 'getSwap', function (h, cb) { cb(null, { hash: h, status: 'LOCKED', buyToken: 'mxUSDT' }); });
        var takerCoin = { coinid: '0xC', tokenid: USDT, tokenamount: '5', state: { '0': '0xTAKER', '2': '[ETH:' + EO.NET.usdt + ']', '3': '999999', '4': '0xMYPK', '5': HASH } };
        stub(H, 'currentBlock', function (cb) { cb(null, 100); });
        stub(H, 'scanByHash', function (h, ca, d, cb) { cb(null, [takerCoin]); });
        stub(H, 'scanByHashDeep', function (h, ca, d, cb) { cb(null, [takerCoin]); });
        stub(H, 'scanByKey', function (pk, ca, d, cb) { cb(null, []); });
        stub(H, 'scanNotifySecret', function (h, d, cb) { cb(null, []); });
        var r1claimed = null;
        stub(H, 'claim', function (c, h, s, addr, cb) { r1claimed = { s: s }; r1.push('claim'); cb(null, '0xTXP'); });
        stub(EO, 'make', function () { return { getContract: function (cid, cb) {
            cb(null, { owner: '0xeth', receiver: '0xTAKERETH', withdrawn: true, refunded: false, preimage: PREIMAGE, amount: 5000000n, tokenContract: EO.NET.usdt, timelock: 3000000000 });
        } }; });
        ST.poll(function () {});                                                        // poll 1: no secret → no claim; ETH pass harvests
        T.ok('R1 poll1: preimage harvested from the withdrawn contract', secrets[HASH] === PREIMAGE);
        T.ok('R1 poll1: no claim yet (secret unknown during the Minima pass)', r1.indexOf('claim') < 0);
        ST._reset();
        ST.poll(function () {});                                                        // poll 2: secret known → claim fires
        T.ok('R1 poll2: maker claims the taker mxUSDT with the HARVESTED preimage', r1claimed && r1claimed.s === PREIMAGE);
        T.ok('R1 poll2: → COMPLETE', r1.indexOf('status:COMPLETE') >= 0);
        restore();

        // ---------- (R2) buy-take maker: taker claimed my mxUSDT revealing state[100] → notify harvest → SAME-poll withdraw ----------
        cfg();
        var r2 = [], secrets2 = {};
        var NSECRET = '0x' + 'cd'.repeat(32);
        stub(DB, 'allSwaps', function (cb) { cb(null, [{ hash: HASH, myLegIsMinima: true, status: 'LOCKED', buyToken: 'USDT' }]); });
        stub(DB, 'getSecret', function (h, cb) { cb(null, secrets2[h] || null); });
        stub(DB, 'insertSecret', function (h, s, cb) { if (!secrets2[h]) secrets2[h] = s; r2.push('harvest'); cb(null); });
        stub(DB, 'getRequest', function (h, cb) { cb(null, null); });
        stub(DB, 'hasEvent', function (h, ev, cb) { cb(null, false); });
        stub(DB, 'logEvent', function (h, ev, tok, amt, note, cb) { cb && cb(null); });
        stub(DB, 'setSwapStatus', function (h, s, cb) { r2.push('status:' + s); cb && cb(null); });
        stub(DB, 'getSwap', function (h, cb) { cb(null, { hash: h, status: 'LOCKED', buyToken: 'USDT' }); });
        stub(H, 'currentBlock', function (cb) { cb(null, 100); });
        stub(H, 'scanByHash', function (h, ca, d, cb) { cb(null, []); });
        stub(H, 'scanByKey', function (pk, ca, d, cb) { cb(null, []); });
        stub(H, 'scanNotifySecret', function (h, d, cb) { cb(null, [{ state: { '100': NSECRET, '101': HASH } }]); });
        var r2withdrew = null;
        stub(EO, 'make', function () { return {
            getContract: function (cid, cb) { cb(null, { owner: '0xTAKERETH', receiver: '0xeth', withdrawn: false, refunded: false, amount: 5000000n, tokenContract: EO.NET.usdt, timelock: 3000000000, preimage: '0x' + '00'.repeat(32) }); },
            withdraw: function (cid, secret, cb) { r2withdrew = { secret: secret }; cb(null, '0xETX'); }
        }; });
        ST.poll(function () {});
        T.ok('R2: secret harvested from the notify coin', secrets2[HASH] === NSECRET);
        T.ok('R2: maker withdraws the taker USDT with the harvested secret SAME poll', r2withdrew && r2withdrew.secret === NSECRET);
        T.ok('R2: → CLAIMING (terminal deferred to gc.withdrawn)', r2.indexOf('status:CLAIMING') >= 0);
        restore();

        // ---------- (R3) an all-zero preimage on an UNwithdrawn contract is NOT harvested ----------
        cfg();
        var secrets3 = {};
        stub(DB, 'allSwaps', function (cb) { cb(null, [{ hash: HASH, myLegIsMinima: true, status: 'LOCKED', buyToken: 'USDT' }]); });
        stub(DB, 'getSecret', function (h, cb) { cb(null, secrets3[h] || null); });
        stub(DB, 'insertSecret', function (h, s, cb) { secrets3[h] = s; cb(null); });
        stub(DB, 'getRequest', function (h, cb) { cb(null, null); });
        stub(DB, 'hasEvent', function (h, ev, cb) { cb(null, false); });
        stub(DB, 'logEvent', function (h, ev, tok, amt, note, cb) { cb && cb(null); });
        stub(DB, 'setSwapStatus', function (h, s, cb) { cb && cb(null); });
        stub(DB, 'getSwap', function (h, cb) { cb(null, { hash: h, status: 'LOCKED', buyToken: 'USDT' }); });
        stub(H, 'currentBlock', function (cb) { cb(null, 100); });
        stub(H, 'scanByHash', function (h, ca, d, cb) { cb(null, []); });
        stub(H, 'scanByKey', function (pk, ca, d, cb) { cb(null, []); });
        stub(H, 'scanNotifySecret', function (h, d, cb) { cb(null, []); });
        stub(EO, 'make', function () { return {
            getContract: function (cid, cb) { cb(null, { owner: '0xTAKERETH', receiver: '0xeth', withdrawn: false, refunded: false, amount: 5000000n, tokenContract: EO.NET.usdt, timelock: 3000000000, preimage: '0x' + '00'.repeat(32) }); },
            withdraw: function (cid, secret, cb) { cb(null, '0xETX'); }
        }; });
        ST.poll(function () {});
        T.ok('R3: zero preimage NOT harvested (no bogus secret stored)', secrets3[HASH] == null);
        restore();

        // ---------- (R4) a hostile mismatch coin must NOT poison the REAL claim (EV_COLLECT-poison, shared native gap) ----------
        // Attacker locks a dust coin carrying my ACTIVE hash + my receiver key but the wrong amount. Old behavior
        // logged EV_COLLECT → hasEvent(EV_COLLECT) then blocked the real coin's claim FOREVER (mutual-refund grief).
        cfg();
        var r4 = [], events4 = {};                                 // realistic event log: hasEvent reflects logEvent
        stub(DB, 'allSwaps', function (cb) { cb(null, [{ hash: HASH, myLegIsMinima: false, status: 'STARTED', buyToken: 'mxUSDT' }]); });
        stub(DB, 'getSecret', function (h, cb) { cb(null, '0xSECRET'); });
        stub(DB, 'getRequest', function (h, cb) { cb(null, { reqAmount: '4.95', reqToken: 'minima' }); });
        stub(DB, 'hasEvent', function (h, ev, cb) { cb(null, !!events4[ev]); });
        stub(DB, 'logEvent', function (h, ev, tok, amt, note, cb) { events4[ev] = 1; r4.push('log:' + ev + ':' + note); cb && cb(null); });
        stub(DB, 'setSwapStatus', function (h, s, cb) { r4.push('status:' + s); cb && cb(null); });
        stub(DB, 'getSwap', function (h, cb) { cb(null, { hash: h, status: 'STARTED', buyToken: 'mxUSDT' }); });
        var poisonCoin = { coinid: '0xBAD', tokenid: USDT, tokenamount: '0.1', state: { '0': '0xATTACKER', '2': '[minima]', '3': '999999', '4': '0xMYPK', '5': HASH } };
        var realCoin = { coinid: '0xGOOD', tokenid: USDT, tokenamount: '4.95', state: { '0': '0xMAKER', '2': '[minima]', '3': '999999', '4': '0xMYPK', '5': HASH } };
        stub(H, 'currentBlock', function (cb) { cb(null, 100); });
        stub(H, 'scanByHash', function (h, ca, d, cb) { cb(null, [poisonCoin, realCoin]); });   // poison seen FIRST
        stub(H, 'scanByHashDeep', function (h, ca, d, cb) { cb(null, [poisonCoin, realCoin]); });
        stub(H, 'scanByKey', function (pk, ca, d, cb) { cb(null, []); });
        stub(H, 'scanNotifySecret', function (h, d, cb) { cb(null, []); });
        var claimed4 = null;
        stub(H, 'claim', function (c, h, s, addr, cb) { claimed4 = { coinid: c.coinid }; cb(null, '0xTXP'); });
        stub(EO, 'make', function () { return { getContract: function (cid, cb) { cb(null, null); } }; });
        ST.poll(function () {});
        T.ok('R4: mismatch logged as EV_MISMATCH, never EV_COLLECT', r4.some(function (x) { return x.indexOf('log:' + DB.EV_MISMATCH) === 0; }) && !r4.some(function (x) { return x.indexOf('log:' + DB.EV_COLLECT + ':counterparty') === 0; }));
        T.ok('R4: the REAL coin still claims despite the poison coin', claimed4 && claimed4.coinid === '0xGOOD');
        // second poll: the once-guard stops mismatch log spam
        var before = r4.filter(function (x) { return x.indexOf('log:' + DB.EV_MISMATCH) === 0; }).length;
        ST._reset(); ST.poll(function () {});
        var after = r4.filter(function (x) { return x.indexOf('log:' + DB.EV_MISMATCH) === 0; }).length;
        T.eq('R4: mismatch logged ONCE (no per-poll spam)', [before, after], [1, 1]);
        restore();
    } finally { restore(); }
})();
