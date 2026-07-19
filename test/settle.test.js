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
    } finally { restore(); }
})();
