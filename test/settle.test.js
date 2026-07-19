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
    } finally { restore(); }
})();
