/* settle_lost — a RESPONDER whose ETH leg was withdrawn and whose Minima counter-leg was reclaimed by the
 * counterparty at its timelock is LOST: ST_ERROR + one SWAP_LOST event + one notification (0.1.32). It used
 * to stay "CLAIMING" forever (2026-09-15, two days on a row with nothing left to claim). */
(function () {
    var ST = AX.settle, DB = AX.swapdb, H = AX.htlc, EO = AX.ethops;
    var undo = [];
    function stub(o, n, f) { undo.push([o, n, o[n]]); o[n] = f; }
    function restore() { for (var i = undo.length - 1; i >= 0; i--) undo[i][0][undo[i][1]] = undo[i][2]; undo = []; }
    var HASH = '0x' + '33'.repeat(32), ME = '0x' + 'ab'.repeat(20);
    var swapRow = { hash: HASH, role: 'RESPONDER', direction: 'MINIMA_TO_ERC20', myLegIsMinima: false, status: 'CLAIMING',
        sellAmount: '4.95', sellToken: 'USDT', buyAmount: '5', buyToken: 'mxUSDT', myTimelock: 1000, contractId: '0xCID' };
    var cpCoin = { coinid: '0xC', tokenid: AX.trading.USDT_TOKENID, tokenamount: '5', state: { '0': '0xMAKER', '3': '150', '4': '0xMYPK', '5': HASH } };

    function scenario(o) {
        var calls = [], notes = [], now = o.now || 5000, status = o.status || 'CLAIMING';
        ST._reset(); ST._setNow(function () { return now * 1000; });
        ST.configure({ rpc: { latestBlockTimestamp: function (cb) { cb(null, 2000000000); } }, ethPriv: '0x' + '11'.repeat(32), ethAddr: ME,
            myMinimaPk: '0xMYPK', myMinimaAddr: 'MxADDR', notify: function (t, b) { notes.push(t + '|' + b); }, onSwapsChanged: function () {} });
        var row = {}; for (var k in swapRow) row[k] = swapRow[k]; row.status = status;
        stub(DB, 'allSwaps', function (cb) { cb(null, [row]); });
        stub(DB, 'getSwap', function (h, cb) { cb(null, row); });
        stub(DB, 'getEvents', function (h, cb) { cb(null, o.events || []); });
        stub(DB, 'getSecret', function (h, cb) { cb(null, '0x' + '08'.repeat(32)); });
        stub(DB, 'getRequest', function (h, cb) { cb(null, null); });
        stub(DB, 'hasEvent', function (h, ev, cb) { cb(null, (o.events || []).some(function (r) { return r.event === ev; })); });
        stub(DB, 'logEvent', function (h, ev, tok, amt, note, cb) { calls.push('log:' + ev + ':' + note); (o.events = o.events || []).push({ event: ev, note: note, date: now * 1000 }); cb && cb(null); });
        stub(DB, 'setSwapStatus', function (h, s, cb) { calls.push('status:' + s); row.status = s; cb && cb(null); });
        stub(DB, 'tradeByHash', function (h, cb) { cb(null, o.trade === undefined ? { hash: h, timelock: 150 } : o.trade); });
        stub(H, 'currentBlock', function (cb) { cb(null, o.block || 200); });
        stub(H, 'scanByHash', function (h, ca, d, cb) { cb(null, []); });
        stub(H, 'scanByHashDeep', function (h, ca, d, cb) { cb(null, o.coin ? [o.coin] : []); });
        stub(H, 'scanByKey', function (pk, ca, d, cb) { cb(null, o.coin ? [o.coin] : []); });
        stub(H, 'claim', function (c, h, s, addr, cb) { calls.push('claim'); cb(new Error('Contract rejected the transaction. Nothing was posted.')); });
        stub(EO, 'make', function () { return { getContract: function (cid, cb) { cb(null, { owner: ME, receiver: '0x' + 'cd'.repeat(20), withdrawn: true, refunded: false, preimage: '0x' + '00'.repeat(32), timelock: 1000, amount: '4950000', tokenContract: EO.NET.usdt }); } }; });
        ST.poll(function () {});
        var r = { calls: calls, notes: notes, row: row, again: function (dt) { now += dt; ST.poll(function () {}); } };
        return r;
    }

    // ---- the 2026-09-15 shape: withdrawn ETH leg, coin gone, block past the observed timelock → LOST, once ----
    var a = scenario({});
    T.ok('lost swap is finalised: ERROR + one SWAP_LOST + one notification', a.calls.indexOf('status:ERROR') >= 0
        && a.calls.filter(function (c) { return c.indexOf('log:SWAP_LOST:counterparty withdrew your 4.95 USDT and reclaimed their 5 mxUSDT') === 0; }).length === 1
        && a.notes.length === 1 && a.notes[0].indexOf(HASH) > 0);
    a.again(200);
    T.ok('a second pass does not repeat it', a.calls.filter(function (c) { return c.indexOf('log:SWAP_LOST') === 0; }).length === 1 && a.notes.length === 1);
    restore();

    // ---- the coin is still there → the claim path owns it; nothing finalised ----
    var b = scenario({ coin: cpCoin });
    T.ok('an open counter-leg is never finalised as lost (claim attempted instead)', b.calls.indexOf('claim') >= 0 && b.calls.indexOf('status:ERROR') < 0 && b.notes.every(function (n) { return n.indexOf('FAILED') !== 0; }));
    restore();

    // ---- coin gone but the observed timelock not yet reached → wait (they may still be mid-claim on our side) ----
    var c = scenario({ block: 120 });
    T.ok('before the leg\'s timelock nothing is finalised', c.calls.indexOf('status:ERROR') < 0);
    restore();

    // ---- a claim submitted minutes ago is confirmPendingMinima's business ----
    var d = scenario({ events: [{ event: 'MINIMA_CLAIM_SUBMITTED', note: '0x' + '55'.repeat(32), date: 5000 * 1000 - 60000 }] });
    T.ok('a recent claim submission blocks the lost verdict', d.calls.indexOf('status:ERROR') < 0);
    restore();

    // ---- lock never observed by the collector: bounded fallback on my own ETH timelock ----
    var e1 = scenario({ trade: null, now: 1000 + 3600 });
    T.ok('no trade row: not lost one hour after my ETH timelock', e1.calls.indexOf('status:ERROR') < 0);
    restore();
    var e2 = scenario({ trade: null, now: 1000 + 5 * 3600 });
    T.ok('no trade row: lost five hours after my ETH timelock', e2.calls.indexOf('status:ERROR') >= 0);
    restore();

    // ---- already terminal rows are left alone ----
    var f = scenario({ status: 'COMPLETE' });
    T.ok('a COMPLETE row is untouched', f.calls.indexOf('status:ERROR') < 0);
    restore();

    T.ok('statusDetail explains ERROR from the projected note', /^Failed — counterparty withdrew/.test(AX.inspect.statusDetail({ status: 'ERROR', lastFail: 'counterparty withdrew your 4.95 USDT …' })));
    T.ok('the Check report flags a SWAP_LOST event', AX.inspect.buildReport({ swap: { status: 'ERROR', myLegIsMinima: false, sellAmount: '4.95', sellToken: 'USDT', buyAmount: '5', buyToken: 'mxUSDT', hash: HASH },
        block: 200, secretKnown: true, myMin: null, cpMin: null, gc: null, myEthStillLocked: false, events: [{ event: 'SWAP_LOST', note: 'counterparty withdrew your 4.95 USDT and reclaimed their 5 mxUSDT at the timelock — our claim never posted' }] })
        .some(function (l) { return l.indexOf('⚠ counterparty withdrew') === 0; }));
    ST._reset(); ST._setNow(function () { return Date.now(); });
})();
