/* stateless_payout — what a claim or refund pays ME is a plain wallet coin (0.1.41, mirrors APK 0.1.97).
 *
 * 2026-11-04, Dexicon on the Fold: a PandaPools pool could not be funded with MxUSD received through AtomiX — every
 * delivered coin carried the swap's state (Minima keeps a txn's state on outputs by default), and stateless-only
 * wallets (PandaPools, PandaDEX) rightly refuse state-bearing coins. Only output 0, the notify, must keep state
 * (the covenant's VERIFYOUT(@INPUT 0xFFEEDD9999 0.0001 @TOKENID TRUE)). */
(function () {
    function cov(c) { var v13 = String(c).indexOf('version=1.3') >= 0 || String(c).indexOf(AX.htlc.ADDRESS_V13) >= 0; return v13 ? { miniaddress: AX.htlc.ADDRESS_V13, address: AX.htlc.ADDRESS_V13_HEX } : { miniaddress: AX.htlc.ADDRESS, address: AX.htlc.ADDRESS_HEX }; }   // the covenant a scripts/newscript command names
    var H = AX.htlc, M = AX.mds, TR = AX.trading, EO = AX.ethops;
    var undo = [];
    function stub(o, n, f) { undo.push([o, n, o[n]]); o[n] = f; }
    function restore() { for (var i = undo.length - 1; i >= 0; i--) undo[i][0][undo[i][1]] = undo[i][2]; undo = []; }
    var HASH = '0x' + '22'.repeat(32), USDT = TR.USDT_TOKENID;
    var coin = { coinid: '0xC', tokenid: USDT, tokenamount: '5', state: { '0': '0xAA', '2': '[ETH:' + EO.NET.usdt + ']', '3': '999999', '4': '0xBB', '5': HASH } };
    function run(fn) {
        var cmds = [];
        stub(M, 'cmd', function (c, cb) { cmds.push(c); cb && cb({ status: true, response: [] }); });
        stub(M, 'cmdR', function (c, cb) {
            cmds.push(c);
            if (c.indexOf('scripts address:') === 0) return cb(null, cov(c), { status: true });
            if (c.indexOf('txncheck ') === 0) return cb(null, { inputs: 1, scripts: 1, validamounts: true, allsignaturesvalid: true, validtransaction: true,
                valid: { basic: true, mmrproofs: true, scripts: true } }, { status: true });
            cb(null, { txpowid: '0x' + '55'.repeat(32) }, { status: true });
        });
        fn();
        restore();
        return cmds.filter(function (c) { return c.indexOf('txnoutput ') === 0; });
    }
    var claimOuts = run(function () { H.claim(coin, HASH, '0xAB', 'MxADDR', function () {}); });
    T.eq('a claim emits the notify and my payout', claimOuts.length, 2);
    T.ok('the notify keeps its state (the covenant requires it)', claimOuts[0].indexOf('storestate:false') < 0);
    T.ok('my payout is a plain wallet coin', claimOuts[1].indexOf('address:MxADDR') > 0 && claimOuts[1].indexOf('storestate:false') > 0);
    var refundOuts = run(function () { H.refund(coin, 'MxADDR', function () {}); });
    T.eq('a refund is one output back to me', refundOuts.length, 1);
    T.ok('the refunded coin is a plain wallet coin', refundOuts[0].indexOf('storestate:false') > 0);
})();
