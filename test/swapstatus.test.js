// review 7 Nov: these suites drive the ETH-first lock path, which ships PAUSED (AX.htlc.ETH_FIRST_PAUSED) until HTLC v1.3
var __ethFirstWas = AX.htlc.ETH_FIRST_PAUSED; AX.htlc.ETH_FIRST_PAUSED = false;
/* swap-status visibility (0.1.39, native 0.1.84 SwapStatusVisibilityTest) — live 2026-10-26: a maker declined a
 * buy (TOO_MANY_COINS) in silence and the taker saw "started" for two hours. Covers: maker decline recording
 * (dedupe, notice cap, every former silent skip in processIncomingBuy), the sealed notice round trip + taker
 * acceptance rules, cleanReason, deadlines, timeout-once, refundNow, the REFUND_SENT event, the card projection.
 * Everything it stubs is restored and every module it configures is reset at the end (test-order coupling). */
(function () {
    var R = AX.responder, ST = AX.settle, DB = AX.swapdb, H = AX.htlc, EO = AX.ethops, TR = AX.trading, O = AX.order,
        D = AX.dec, ID = AX.identity, TK = AX.take;
    var undo = [];
    function stub(o, n, f) { undo.push([o, n, o[n]]); o[n] = f; }
    function restore() { for (var i = undo.length - 1; i >= 0; i--) undo[i][0][undo[i][1]] = undo[i][2]; undo = []; }

    // ---- in-memory events + swaps (the only DB surface these paths use) ----
    var evs = [], swaps = {}, tick = 0;
    function evsOf(h, ev) { return evs.filter(function (e) { return e.hash === DB.norm(h) && (!ev || e.event === ev); }); }
    function dbStubs() {
        stub(DB, 'getEvents', function (h, cb) { cb(null, evsOf(h).slice().reverse()); });
        stub(DB, 'hasEvent', function (h, ev, cb) { cb(null, evsOf(h, ev).length > 0); });
        stub(DB, 'logEvent', function (h, ev, t, a, note, cb) { evs.push({ hash: DB.norm(h), event: ev, token: t, note: note, date: ++tick }); cb && cb(null); });
        stub(DB, 'getSwap', function (h, cb) { cb(null, swaps[DB.norm(h)] || null); });
        stub(DB, 'allSwaps', function (cb) { cb(null, Object.keys(swaps).map(function (k) { return swaps[k]; })); });
        stub(DB, 'upsertSwap', function (s, cb) { cb && cb(null); });
        stub(DB, 'deleteSwap', function (h, cb) { cb && cb(null); });
        stub(DB, 'setSwapStatus', function (h, s, cb) { cb && cb(null); });
    }
    function H32(b) { return '0x' + b.repeat(32); }

    try {
        // ======================= pure helpers =======================
        T.eq('cleanReason: control chars → space, trimmed', TK.cleanReason('  a\nb\tc\u0007 '), 'a b c');
        T.eq('cleanReason: capped at 240', TK.cleanReason('x'.repeat(500)).length, 240);
        T.eq('cleanReason: null → empty', TK.cleanReason(null), '');
        var dE = ST.deadlines({ role: 'INITIATOR', myTimelock: 1000000, myLegIsMinima: false });
        T.eq('deadlines: ETH-first = secs, respondBy = timelock − CP_SECS_CHECK', [dE.blocks, dE.respondBy, dE.refundAt], [false, 1000000 - H.CP_SECS_CHECK, 1000000]);
        var dM = ST.deadlines({ role: 'INITIATOR', myTimelock: 5000, myLegIsMinima: true });
        T.eq('deadlines: Minima-first = blocks, respondBy = timelock − CP_BLOCKS_CHECK', [dM.blocks, dM.respondBy, dM.refundAt], [true, 5000 - H.CP_BLOCKS_CHECK, 5000]);
        T.eq('deadlines: a RESPONDER row has none', ST.deadlines({ role: 'RESPONDER', myTimelock: 5000 }), null);
        T.eq('deadlines: no timelock → none', ST.deadlines({ role: 'INITIATOR', myTimelock: 0 }), null);

        // ======================= maker: every former silent skip records a reason =======================
        dbStubs();
        var maker = ID.fromSeed('status-maker', 'usdtswap'), taker = ID.fromSeed('status-taker', 'usdtswap');
        var sent = [];
        stub(TK, 'notice', function (me, to, from, hash, state, reason, cb) { sent.push({ to: to, hash: hash, state: state, reason: reason }); cb(null); });
        var o = O.make(), p = O.pair(true, 0, 0, 1); p.asks = [O.level(1.01, 100)]; o.pairs.USDT = p;
        var order = o, NOW = 2000000000;
        R._reset();
        R.configure({ rpc: { latestBlockTimestamp: function (cb) { cb(null, NOW); } }, ethPriv: H32('11'), ethAddr: '0xME',
            myMinimaPk: '0xMYPK', myMinimaAddr: 'MxADDR', myIdentity: maker, getOrder: function () { return order; },
            notify: function () {}, onSwapsChanged: function () {} });
        var contracts = {};
        function contract(h, give, pay, extra) {
            var c = { hashlock: h, contractId: EO.contractId(h), receiver: '0xME', timelock: NOW + 7000, tokenContract: EO.NET.usdt,
                requestAmount: D.parseUnits(String(give), 18), amount: D.parseUnits(String(pay), 6), minimaPublicKey: '0xTAKERPK',
                withdrawn: false, refunded: false };
            for (var k in extra || {}) c[k] = extra[k];
            contracts[EO.contractId(h)] = c; return c;
        }
        stub(EO, 'make', function () { return { getContract: function (cid, cb) { cb(null, contracts[cid] || null); } }; });
        var coinsReply = { e: null, coins: [{ coinid: '0xC1', tokenamount: '500' }, { coinid: '0xC2', tokenamount: '500' }, { coinid: '0xC3', tokenamount: '500' }] };
        stub(H, 'myFreeCoins', function (tok, cb) { cb(coinsReply.e, coinsReply.coins); });
        var hung = [];
        stub(H, 'lockFromCoins', function (args, cb) { hung.push(cb); });
        function run(h) { var done = false; R.processIncomingBuy(h, 100, NOW, function () { done = true; }); return done; }
        function declined(h) { return evsOf(h, DB.EV_DECLINED).map(function (e) { return e.note; }); }
        function tell(h) { R._takerOf()[DB.norm(h)] = taker.publicId(); }

        var hR = H32('a1'); contract(hR, 50, 51, { receiver: '0xSOMEONEELSE' }); tell(hR);
        T.ok('skip: receiver mismatch → next() still called', run(hR));
        T.ok('skip: receiver mismatch records the FULL addresses', /0xSOMEONEELSE/.test(declined(hR)[0]) && /0xME/.test(declined(hR)[0]));
        T.eq('skip: receiver mismatch is final → "declined" notice to the taker', sent.length && [sent[0].state, sent[0].to, sent[0].hash], ['declined', taker.publicId(), hR]);
        run(hR);
        T.eq('dedupe: the same (hash, reason) is recorded once', declined(hR).length, 1);
        T.eq('dedupe: …and sent once', sent.length, 1);

        var hT = H32('a2'); contract(hT, 50, 51, { timelock: NOW + 100 });
        run(hT);
        T.ok('skip: lock too close to timeout records a reason', /too close to its timeout/.test(declined(hT)[0] || ''));
        T.eq('no taker id from a handshake → no notice (recorded only)', sent.length, 1);

        var hN = H32('a3'); contract(hN, 50, 51); order = null;
        run(hN);
        T.ok('skip: no live order records a reason', /no live order/.test(declined(hN)[0] || ''));
        order = o;

        var hL = H32('a4'); contract(hL, 50, 50);
        run(hL);
        T.ok('skip: ladder misfit records the numbers', /50 USDT for 50/.test(declined(hL)[0] || '') && /1\.01 up to 100/.test(declined(hL)[0] || ''));

        var hW = H32('a5'); contract(hW, 50, 51); tell(hW);
        coinsReply = { e: new Error('TOO_MANY_COINS: 56 coins'), coins: [] };
        run(hW);
        T.ok('skip: myFreeCoins error (TOO_MANY_COINS) records the native text',
            declined(hW)[0] === 'Maker wallet: TOO_MANY_COINS: 56 coins — it consolidates automatically and retries.');
        T.eq('TOO_MANY_COINS is "retrying"', sent[sent.length - 1].state, 'retrying');

        var hE = H32('a6'); contract(hE, 50, 51);
        coinsReply = { e: null, coins: [{ coinid: '0xD1', tokenamount: '1' }] };
        run(hE);
        T.ok('skip: not enough free coins records a reason', /not enough free/.test(declined(hE)[0] || ''));

        // burst: two fitting takes hold their reservations (lock still building) → the third is "busy"
        coinsReply = { e: null, coins: [{ coinid: '0xC1', tokenamount: '500' }, { coinid: '0xC2', tokenamount: '500' }, { coinid: '0xC3', tokenamount: '500' }] };
        var hB1 = H32('b1'), hB2 = H32('b2'), hB3 = H32('b3');
        contract(hB1, 50, 51); contract(hB2, 50, 51); contract(hB3, 50, 51);
        run(hB1); run(hB2);
        T.eq('burst: two locks in flight', hung.length, 2);
        run(hB3);
        T.ok('skip: burst full records "busy" (retrying)', /Maker busy/.test(declined(hB3)[0] || ''));
        hung[0](new Error('txnsign refused'));   // build failure (no POSTED: tag) — provably not broadcast
        T.ok('skip: lock build failure records a reason', /Maker lock failed: txnsign refused/.test(declined(hB1)[0] || ''));
        hung[1](new Error('POSTED:0xTXP lost reply'));   // may have broadcast → NOT a decline
        T.eq('a POSTED failure is not reported as a decline', declined(hB2).length, 0);

        // notice cap: at most 3 per hash, across distinct reasons
        var hC = H32('c1'); tell(hC); var before = sent.length;
        for (var i = 0; i < 5; i++) R.recordDecline(hC, 'reason ' + i, false);
        T.eq('cap: 5 distinct reasons → 5 events', declined(hC).length, 5);
        T.eq('cap: …but only 3 notices', sent.length - before, R.MAX_NOTICES_PER_HASH);
        restore(); R._reset(); R.configure(null);

        // ======================= sealed notice round trip + taker acceptance =======================
        dbStubs();
        var HS = H32('d1'), posted = [];
        stub(AX.mds, 'cmdR', function (cmd, cb) { posted.push(cmd); cb(null, {}); });
        TK.notice(maker, taker.publicId(), maker.publicId(), HS, 'declined', 'Maker wallet: TOO_MANY_COINS\nnow', function () {});
        var evil = ID.fromSeed('status-evil', 'usdtswap');
        TK.notice(evil, taker.publicId(), maker.publicId(), HS, 'declined', 'forged sender claim', function () {});   // claims to be the maker
        TK.notice(evil, taker.publicId(), evil.publicId(), HS, 'declined', 'not the maker I told', function () {});
        TK.send(maker, taker.publicId(), maker.publicId(), H32('d2'), function () {});   // a handshake (no notice) — taker w/o order ignores
        T.eq('notice: posted to the TAKE channel like a handshake', posted.length && posted[0].indexOf('address:' + TK.address()) > 0, true);
        function coinOf(cmd) { return { state: JSON.parse(cmd.slice(cmd.indexOf('state:') + 6)) }; }
        var takeCoins = Array.from(posted.map(coinOf));
        stub(AX.mds, 'cmd', function (cmd, cb) { cb(cmd.indexOf('coins ') === 0 ? { status: true, response: takeCoins } : { status: true }); });
        stub(H, 'tokenBalance', function (t, cb) { cb(new Error('n/a')); });
        stub(AX.otc, 'allDeals', function (cb) { cb(null, []); });
        swaps[DB.norm(HS)] = { hash: DB.norm(HS), role: 'INITIATOR', status: 'STARTED', myLegIsMinima: false, myTimelock: NOW + 7200, sellAmount: '50.5', sellToken: 'USDT' };
        DB.logEvent(HS, DB.EV_TAKE_SENT, '', '', maker.publicId());
        var notes = [];
        ST._reset(); ST.configure({ rpc: { latestBlockTimestamp: function (cb) { cb(null, NOW); } }, ethPriv: H32('11'), ethAddr: '0xME',
            myMinimaPk: '0xMYPK', myMinimaAddr: 'MxADDR', notify: function (t, b) { notes.push(t + ': ' + b); }, onSwapsChanged: function () {} });
        R._reset(); R._resetKeeper();
        R.configure({ rpc: { latestBlockTimestamp: function (cb) { cb(null, NOW); } }, ethPriv: H32('11'), ethAddr: '0xME',
            myMinimaPk: '0xMYPK', myMinimaAddr: 'MxADDR', myIdentity: taker, getOrder: function () { return null; },
            notify: function () {}, onSwapsChanged: function () {} });
        var scanned = false;
        R.scanIncomingBuys(100, function () { scanned = true; });
        T.ok('taker scan: runs with NO order while a buy is waiting', scanned);
        var mn = evsOf(HS, DB.EV_MAKER_NOTICE);
        T.eq('taker: exactly the genuine maker notice is accepted', mn.map(function (e) { return e.note; }), ['declined|Maker wallet: TOO_MANY_COINS now']);
        T.ok('taker: user notified with the FULL hash', notes.length === 1 && notes[0].indexOf('Maker declined your swap') === 0 && notes[0].indexOf(HS) > 0);
        T.eq('taker without an order: a handshake is not queued', Object.keys(R._incoming()).length, 0);
        R.scanIncomingBuys(100, function () {});
        T.eq('taker: rescanning the same notice is deduped', evsOf(HS, DB.EV_MAKER_NOTICE).length, 1);

        // acceptance rules, direct
        var accepted = null;
        ST.onMakerNotice(HS, maker.publicId(), 'retrying', 'Maker busy', function (n) { accepted = n; });
        T.eq('accept: a new reason from the recorded maker', accepted, true);
        ST.onMakerNotice(HS, maker.publicId(), 'weird-state', 'x', function () {});
        T.eq('accept: an unknown state is stored as retrying', evsOf(HS, DB.EV_MAKER_NOTICE).slice(-1)[0].note, 'retrying|x');
        ST.onMakerNotice(HS, evil.publicId(), 'declined', 'y', function (n) { accepted = n; });
        T.eq('reject: a sender other than the maker I told', accepted, false);
        var HR = H32('d3'); swaps[DB.norm(HR)] = { hash: DB.norm(HR), role: 'RESPONDER', status: 'LOCKED' };
        DB.logEvent(HR, DB.EV_TAKE_SENT, '', '', maker.publicId());
        ST.onMakerNotice(HR, maker.publicId(), 'declined', 'z', function (n) { accepted = n; });
        T.eq('reject: not my initiator swap', accepted, false);
        var HX = H32('d4'); swaps[DB.norm(HX)] = { hash: DB.norm(HX), role: 'INITIATOR', status: 'STARTED', myTimelock: NOW + 7200 };
        ST.onMakerNotice(HX, maker.publicId(), 'declined', 'z', function (n) { accepted = n; });
        T.eq('reject: no TAKE_SENT recorded for the swap', accepted, false);

        // maker side of the same scan: the handshake's AUTHENTICATED sender becomes where notices go
        R._reset();
        R.configure({ rpc: { latestBlockTimestamp: function (cb) { cb(null, NOW); } }, ethPriv: H32('11'), ethAddr: '0xME',
            myMinimaPk: '0xMYPK', myMinimaAddr: 'MxADDR', myIdentity: maker, getOrder: function () { return o; },
            notify: function () {}, onSwapsChanged: function () {} });
        posted.length = 0;
        TK.send(taker, maker.publicId(), taker.publicId(), H32('e1'), function () {});
        takeCoins = Array.from(posted.map(coinOf));
        stub(EO, 'make', function () { return { getContract: function (cid, cb) { cb(null, null); } }; });
        R.scanIncomingBuys(100, function () {});
        T.eq('maker: handshake sender recorded as the notice target', R._takerOf()[DB.norm(H32('e1'))], ID.canonicalId(taker.publicId()));
        restore(); R._reset(); R.configure(null);

        // ======================= timeouts, refundNow, REFUND_SENT, projection =======================
        dbStubs();
        evs = []; swaps = {}; notes = [];
        var kicks = 0, chainNow = NOW;
        ST._reset();
        ST.configure({ rpc: { latestBlockTimestamp: function (cb) { cb(null, chainNow); } }, ethPriv: H32('11'), ethAddr: '0xME',
            myMinimaPk: '0xMYPK', myMinimaAddr: 'MxADDR', notify: function (t, b) { notes.push(t + ': ' + b); }, onSwapsChanged: function () {},
            kick: function () { kicks++; } });
        ST._setNow(function () { return NOW * 1000; });
        var HE = H32('f1'), HM = H32('f2');
        swaps[DB.norm(HE)] = { hash: DB.norm(HE), role: 'INITIATOR', status: 'STARTED', myLegIsMinima: false, myTimelock: NOW + 600, sellAmount: '50.5', sellToken: 'USDT' };
        swaps[DB.norm(HM)] = { hash: DB.norm(HM), role: 'INITIATOR', status: 'STARTED', myLegIsMinima: true, myTimelock: 150, sellAmount: '50', sellToken: 'MxUSD' };
        ST.noteTimeouts(70, function () {});
        T.eq('timeout: ETH-first past respondBy → one MAKER_TIMEOUT', evsOf(HE, DB.EV_TIMEOUT).length, 1);
        T.eq('timeout: Minima-first not yet (block 70 < 150 − 72)', evsOf(HM, DB.EV_TIMEOUT).length, 0);
        T.ok('timeout: notification names the refund time and the FULL hash', notes.length === 1 && notes[0].indexOf('Maker did not respond in time') === 0 && notes[0].indexOf(HE) > 0);
        ST.noteTimeouts(80, function () {});
        T.eq('timeout: said ONCE', evsOf(HE, DB.EV_TIMEOUT).length, 1);
        T.eq('timeout: Minima-first at block 80 ≥ 78', evsOf(HM, DB.EV_TIMEOUT).length, 1);

        var ans = null;
        ST.refundNow(HE, function (m, opened) { ans = [m, opened]; });
        T.ok('refundNow before the ETH timelock: says exactly when', ans[1] === false && /only accepts a refund after/.test(ans[0]) && /11 min from now/.test(ans[0]));
        T.eq('refundNow before: no settlement pass kicked', kicks, 0);
        stub(H, 'currentBlock', function (cb) { cb(null, 100); });
        ST.refundNow(HM, function (m, opened) { ans = [m, opened]; });
        T.ok('refundNow before the Minima timelock: block + count', ans[1] === false && /after block 150 \(51 blocks/.test(ans[0]));
        chainNow = NOW + 601; ST._ethAttempt()['refundE:' + DB.norm(HE)] = NOW;
        ST.refundNow(HE, function (m, opened) { ans = [m, opened]; });
        T.eq('refundNow after the timelock: opened + kicked', [ans[1], kicks], [true, 1]);
        T.ok('refundNow after: retry window cleared', !('refundE:' + DB.norm(HE) in ST._ethAttempt()));
        ST.refundNow(H32('ff'), function (m) { ans = [m]; });
        T.eq('refundNow: unknown swap', ans[0], 'No such swap on this device.');

        // REFUND_SENT: the ETH refund broadcast is recorded + notified once, tx IN FULL
        var TX = H32('ab'), refunds = 0;
        swaps = {}; swaps[DB.norm(HE)] = { hash: DB.norm(HE), role: 'INITIATOR', status: 'STARTED', myLegIsMinima: false, myTimelock: NOW + 600, sellAmount: '50.5', sellToken: 'USDT' };
        stub(DB, 'getSecret', function (h, cb) { cb(null, '0xS'); });
        stub(DB, 'getRequest', function (h, cb) { cb(null, null); });
        stub(H, 'scanByHashDeep', function (h, ca, d, cb) { cb(null, []); });
        stub(H, 'scanByKey', function (pk, ca, d, cb) { cb(null, []); });
        stub(EO, 'make', function () { return {
            getContract: function (cid, cb) { cb(null, { owner: '0xME', receiver: '0xMAKER', timelock: NOW + 600, withdrawn: false, refunded: false, preimage: H32('00') }); },
            refund: function (cid, cb) { refunds++; cb(null, TX); } }; });
        notes = [];
        ST.poll(function () {});
        T.eq('refund broadcast: one REFUND_SENT with the tx', evsOf(HE, DB.EV_REFUND_SENT).map(function (e) { return e.note; }), [TX]);
        T.ok('refund broadcast: "Refund sent" with the FULL tx', notes.some(function (n) { return n.indexOf('Refund sent') === 0 && n.indexOf(TX) > 0; }));
        T.eq('refund event carries no ETH token (keeps the CSV Eth Tx column a single leg tx)', evsOf(HE, DB.EV_REFUND_SENT)[0].token, '');
        ST._reset(); ST.poll(function () {});
        T.eq('refund re-broadcast: still ONE REFUND_SENT', [refunds, evsOf(HE, DB.EV_REFUND_SENT).length], [2, 1]);

        var v = ST.visibility(swaps[DB.norm(HE)], evsOf(HE).slice().reverse().concat([{ event: DB.EV_MAKER_NOTICE, note: 'declined|too many coins', date: 1 }]));
        T.eq('projection: deadlines', [v.blocks, v.respondBy, v.refundAt], [false, NOW + 600 - H.CP_SECS_CHECK, NOW + 600]);
        T.eq('projection: notice split into state + reason', [v.notice.state, v.notice.reason], ['declined', 'too many coins']);
        T.eq('projection: timeout + refund tx in full', [v.timedOut, v.refundSent], [true, TX]);
        T.ok('projection: steps include the refund', v.steps.indexOf('Refund sent') >= 0);
        T.eq('projection: none for a maker row', ST.visibility({ role: 'RESPONDER', myTimelock: 5 }, []), null);
    } catch (e) {
        T.ok('swapstatus suite threw: ' + (e && e.stack || e), false);
    } finally {
        restore();
        R._reset(); R._resetKeeper(); R.configure(null);
        ST._reset(); ST._setNow(Date.now); ST.configure(null);
    }
})();
AX.htlc.ETH_FIRST_PAUSED = __ethFirstWas;
