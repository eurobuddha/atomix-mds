/* settle_claimfail — a refused claim/refund must be VISIBLE and SELF-HEALING (0.1.31).
 *
 * 2026-09-15, minimaCore Desktop: the node lost the covenant's script row, txnbasics built every claim without
 * its ScriptProof, txncheck refused ~45 attempts over two hours, settle.js discarded each error, and the
 * counterparty refunded at the timelock keeping both sides. These assert the four things that would have
 * prevented that: the failure is NAMED (SCRIPT_MISSING), the covenant is re-registered and the build retried
 * once at once, a persistent failure is logged/notified once per distinct reason, and a healed/transport
 * failure clears the retry stamp so the next poll retries. */
(function () {
    var ST = AX.settle, DB = AX.swapdb, H = AX.htlc, M = AX.mds, EO = AX.ethops, TR = AX.trading;
    var undo = [];
    function stub(o, n, f) { undo.push([o, n, o[n]]); o[n] = f; }
    function restore() { for (var i = undo.length - 1; i >= 0; i--) undo[i][0][undo[i][1]] = undo[i][2]; undo = []; }
    var HASH = '0x' + '22'.repeat(32), USDT = TR.USDT_TOKENID;
    var coin = { coinid: '0xC', tokenid: USDT, tokenamount: '5', state: { '0': '0xMAKER', '2': '[ETH:' + EO.NET.usdt + ']', '3': '999999', '4': '0xMYPK', '5': HASH } };
    // H.claim's MA-19 guards reject non-hex state keys, so the direct H.claim checks use hex owner/receiver keys.
    var hexCoin = { coinid: '0xC', tokenid: USDT, tokenamount: '5', state: { '0': '0xAA', '2': '[ETH:' + EO.NET.usdt + ']', '3': '999999', '4': '0xBB', '5': HASH } };

    // ---------- H.claim: txncheck "scripts 0 of 1" → SCRIPT_MISSING → one newscript → rebuilt → posted ----------
    (function () {
        var cmds = [], registered = false, checks = 0;
        function node(command) {
            if (command.indexOf('scripts address:') === 0) return registered ? { miniaddress: H.ADDRESS } : null;
            if (command.indexOf('newscript') === 0) { registered = true; return { miniaddress: H.ADDRESS, address: H.ADDRESS_HEX }; }
            if (command.indexOf('txncheck ') === 0) {
                checks++;
                var scripts = registered ? 1 : 0;
                return { inputs: 1, scripts: scripts, validamounts: true, allsignaturesvalid: true, validtransaction: scripts === 1,
                    valid: { basic: true, mmrproofs: true, scripts: scripts === 1 } };
            }
            return { txpowid: '0x' + '55'.repeat(32) };
        }
        stub(M, 'cmd', function (c, cb) { cmds.push(c); cb && cb({ status: true, response: [] }); });
        stub(M, 'cmdR', function (c, cb) {
            cmds.push(c);
            var r = node(c);
            if (r === null) return cb(new Error('cmd failed: ' + c + ' — not found'), null, { status: false });
            cb(null, r, { status: true, response: r });
        });
        var out = null;
        H.claim(hexCoin, HASH, '0xAB', 'MxADDR', function (e, txp) { out = { e: e, txp: txp }; });
        var newscripts = cmds.filter(function (c) { return c.indexOf('newscript') === 0; }).length;
        var posts = cmds.filter(function (c) { return c.indexOf('txnpost ') === 0; }).length;
        var deletes = cmds.filter(function (c) { return c.indexOf('txndelete ') === 0; }).length;
        T.ok('absent covenant row is registered BEFORE the first build (verified read → newscript)', cmds[0].indexOf('scripts address:') === 0 && cmds[1].indexOf('newscript') === 0);
        T.ok('claim posts once the covenant is registered', out && !out.e && out.txp === '0x' + '55'.repeat(32) && posts === 1);
        T.eq('one registration, no rebuild needed when the pre-read healed it', newscripts, 1);
        T.eq('no half-built transaction left behind', deletes, 0);
        restore();
    })();

    // ---------- the row vanishes AFTER the pre-read: txncheck says scripts 0 → re-register → rebuild ONCE ----------
    (function () {
        var cmds = [], vanishAfterRead = true, registered = true;
        function node(command) {
            if (command.indexOf('scripts address:') === 0) { var r = registered ? { miniaddress: H.ADDRESS } : null; if (vanishAfterRead) { registered = false; vanishAfterRead = false; } return r; }
            if (command.indexOf('newscript') === 0) { registered = true; return { miniaddress: H.ADDRESS }; }
            if (command.indexOf('txncheck ') === 0) {
                var scripts = registered ? 1 : 0;
                return { inputs: 1, scripts: scripts, validamounts: true, allsignaturesvalid: true, validtransaction: scripts === 1,
                    valid: { basic: true, mmrproofs: true, scripts: scripts === 1 } };
            }
            return { txpowid: '0xTXP' };
        }
        stub(M, 'cmd', function (c, cb) { cmds.push(c); cb && cb({ status: true, response: [] }); });
        stub(M, 'cmdR', function (c, cb) { cmds.push(c); var r = node(c); if (r === null) return cb(new Error('cmd failed'), null, { status: false }); cb(null, r, { status: true, response: r }); });
        var out = null;
        H.claim(hexCoin, HASH, '0xAB', 'MxADDR', function (e, txp) { out = { e: e, txp: txp }; });
        var creates = cmds.filter(function (c) { return c.indexOf('txncreate ') === 0; }).length;
        var checks = cmds.filter(function (c) { return c.indexOf('txncheck ') === 0; }).length;
        var deletes = cmds.filter(function (c) { return c.indexOf('txndelete ') === 0; }).length;
        var posts = cmds.filter(function (c) { return c.indexOf('txnpost ') === 0; }).length;
        T.ok('refused build is deleted, covenant re-registered, rebuilt once, posted', out && !out.e && creates === 2 && checks === 2 && deletes === 1 && posts === 1
            && cmds.filter(function (c) { return c.indexOf('newscript') === 0; }).length === 1);
        T.ok('the first txndelete precedes the second txncreate', cmds.indexOf('txndelete id:' + cmds[cmds.indexOf('txncreate id:' + cmds.filter(function (c) { return c.indexOf('txncreate ') === 0; })[0].slice(13)) ].slice(13)) < cmds.lastIndexOf(cmds.filter(function (c) { return c.indexOf('txncreate ') === 0; })[1]));
        restore();
    })();

    // ---------- a REAL contract rejection (scripts 1 of 1, valid.scripts false) is NOT a missing script ----------
    (function () {
        var cmds = [];
        stub(M, 'cmd', function (c, cb) { cmds.push(c); cb && cb({ status: true, response: [] }); });
        stub(M, 'cmdR', function (c, cb) {
            cmds.push(c);
            var r = c.indexOf('scripts address:') === 0 ? { miniaddress: H.ADDRESS }
                : c.indexOf('txncheck ') === 0 ? { inputs: 1, scripts: 1, validamounts: true, allsignaturesvalid: true, validtransaction: false, valid: { basic: true, mmrproofs: true, scripts: false } }
                : { txpowid: '0xTXP' };
            cb(null, r, { status: true, response: r });
        });
        var out = null;
        H.claim(hexCoin, HASH, '0xAB', 'MxADDR', function (e) { out = e; });
        T.ok('genuine rejection surfaces as such, no re-registration, one build', out && out.code !== 'SCRIPT_MISSING' && /Contract rejected/.test(out.message)
            && cmds.filter(function (c) { return c.indexOf('newscript') === 0; }).length === 0
            && cmds.filter(function (c) { return c.indexOf('txncreate ') === 0; }).length === 1);
        T.ok('the error carries the txncheck verdict and the failing step', out && out.step === 'txncheck' && out.detail && out.detail.valid && out.detail.valid.scripts === false);
        restore();
    })();

    // ---------- settle: a persistent failure is logged + notified ONCE per reason; stamp cleared when healable ----------
    function baseDbStubs(swaps, calls) {
        stub(DB, 'allSwaps', function (cb) { cb(null, swaps.slice()); });
        stub(DB, 'getEvents', function (h, cb) { cb(null, []); });
        stub(DB, 'getSecret', function (h, cb) { cb(null, '0xSECRET'); });
        stub(DB, 'getRequest', function (h, cb) { cb(null, null); });
        stub(DB, 'hasEvent', function (h, ev, cb) { cb(null, false); });
        stub(DB, 'logEvent', function (h, ev, tok, amt, note, cb) { calls.push('log:' + ev + ':' + note); cb && cb(null); });
        stub(DB, 'setSwapStatus', function (h, s, cb) { calls.push('status:' + s); cb && cb(null); });
        stub(DB, 'getSwap', function (h, cb) { cb(null, { hash: h, status: 'LOCKED', buyToken: 'USDT', role: 'RESPONDER' }); });
        stub(H, 'currentBlock', function (cb) { cb(null, 100); });
        stub(H, 'scanByHash', function (h, ca, d, cb) { cb(null, [coin]); });
        stub(H, 'scanByHashDeep', function (h, ca, d, cb) { cb(null, [coin]); });
        stub(H, 'scanByKey', function (pk, ca, d, cb) { cb(null, [coin]); });   // the every-poll backstop finds it too (as on a real node)
        stub(EO, 'make', function () { return { getContract: function (cid, cb) { cb(null, null); } }; });
    }
    (function () {
        var calls = [], notes = [], now = 1000;
        ST._reset(); ST._setNow(function () { return now * 1000; });
        ST.configure({ rpc: { latestBlockTimestamp: function (cb) { cb(null, 2000000000); } }, ethPriv: '0x' + '11'.repeat(32), ethAddr: '0xETH',
            myMinimaPk: '0xMYPK', myMinimaAddr: 'MxADDR', notify: function (t, b) { notes.push(t + '|' + b); }, onSwapsChanged: function () {} });
        baseDbStubs([{ hash: HASH, myLegIsMinima: false, status: 'LOCKED' }], calls);
        var attempts = 0, failWith = function () { var e = new Error('Contract rejected the transaction. Nothing was posted.'); e.step = 'txncheck'; return e; };
        stub(H, 'claim', function (c, h, s, addr, cb) { attempts++; cb(failWith()); });
        ST.poll(function () {});
        T.ok('first refusal: CLAIMING written, one MINIMA_CLAIM_FAILED with the reason, one notification naming the swap',
            attempts === 1 && calls.indexOf('status:CLAIMING') >= 0
            && calls.filter(function (c) { return c.indexOf('log:MINIMA_CLAIM_FAILED:Contract rejected') === 0; }).length === 1
            && notes.length === 1 && notes[0].indexOf(HASH) > 0);
        now += 200; ST.poll(function () {});   // past ETH_RETRY_SECS → retried; same reason → no second row/notice
        T.ok('same reason again: retried, but not logged or notified twice', attempts === 2
            && calls.filter(function (c) { return c.indexOf('log:MINIMA_CLAIM_FAILED') === 0; }).length === 1 && notes.length === 1);
        failWith = function () { var e = new Error('Input spent or invalid proof. Nothing was posted.'); e.step = 'txncheck'; return e; };
        now += 200; ST.poll(function () {});
        T.ok('a NEW reason is logged and notified once more', attempts === 3
            && calls.filter(function (c) { return c.indexOf('log:MINIMA_CLAIM_FAILED:Input spent') === 0; }).length === 1 && notes.length === 2);
        now += 10; ST.poll(function () {});
        T.ok('a genuine rejection keeps the retry window (no attempt 10s later)', attempts === 3);
        // a healable failure clears the stamp: the very next poll retries
        failWith = function () { var e = new Error('script proof missing — the node has no script row for the covenant address. Nothing was posted.'); e.code = 'SCRIPT_MISSING'; return e; };
        now += 200; ST.poll(function () {});
        var after = attempts;
        now += 10; ST.poll(function () {});
        T.ok('a SCRIPT_MISSING failure retries on the next poll instead of waiting the window', after === 4 && attempts === 5);
        failWith = function () { return new Error('cmd failed: txnstate id:x — RPC timeout'); };
        now += 200; ST.poll(function () {}); after = attempts;
        now += 10; ST.poll(function () {});
        T.ok('a transport failure (RPC timeout) retries on the next poll too', attempts === after + 1);
        // success clears lastFail so a later identical failure is reported again
        stub(H, 'claim', function (c, h, s, addr, cb) { cb(null, '0xTXP'); });
        now += 200; ST.poll(function () {});
        T.ok('success records MINIMA_CLAIM_SUBMITTED', calls.indexOf('log:MINIMA_CLAIM_SUBMITTED:0xTXP') >= 0);
        restore(); ST._reset(); ST._setNow(function () { return Date.now(); });
    })();

    // ---------- refund twin ----------
    (function () {
        var calls = [], notes = [], now = 1000;
        ST._reset(); ST._setNow(function () { return now * 1000; });
        ST.configure({ rpc: { latestBlockTimestamp: function (cb) { cb(null, 2000000000); } }, ethPriv: '0x' + '11'.repeat(32), ethAddr: '0xETH',
            myMinimaPk: '0xMYPK', myMinimaAddr: 'MxADDR', notify: function (t, b) { notes.push(t + '|' + b); }, onSwapsChanged: function () {} });
        var mine = { coinid: '0xD', tokenid: USDT, tokenamount: '5', state: { '0': '0xMYPK', '3': '50', '4': '0xTAKER', '5': HASH } };
        baseDbStubs([{ hash: HASH, myLegIsMinima: true, status: 'STARTED', myTimelock: 50 }], calls);
        stub(H, 'scanByHashDeep', function (h, ca, d, cb) { cb(null, [mine]); });
        stub(DB, 'getSecret', function (h, cb) { cb(null, null); });
        stub(H, 'refund', function (c, addr, cb) { var e = new Error('Contract rejected the transaction. Nothing was posted.'); cb(e); });
        ST.poll(function () {});
        T.ok('refund refusal is logged as MINIMA_REFUND_FAILED and notified', calls.filter(function (c) { return c.indexOf('log:MINIMA_REFUND_FAILED:Contract rejected') === 0; }).length === 1 && notes.length === 1);
        restore(); ST._reset(); ST._setNow(function () { return Date.now(); });
    })();

    // ---------- statusDetail shows the reason on the row when the host projects it ----------
    T.ok('statusDetail names a failing claim', /Claim FAILING — script proof missing/.test(AX.inspect.statusDetail({ status: 'CLAIMING', lastFail: 'script proof missing — x.', buyamount: '5', buytoken: 'mxUSDT' })));
    T.ok('statusDetail unchanged without a failure', /claiming your 5 mxUSDT now/.test(AX.inspect.statusDetail({ status: 'CLAIMING', buyamount: '5', buytoken: 'mxUSDT' })));
})();
