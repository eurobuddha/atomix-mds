/* settle_neverlocked — port of native SwapEngine.finalizeIfNeverLocked (AtomiX 0.1.93–0.1.95). A maker whose own
 * USDT newContract REVERTED kept the row LOCKED forever, shown as a live swap that never cleared (minimaCore Desktop,
 * 2026-11-05: 58.615613 USDT, lock tx reverted on 29 Oct). Past timelock + 1h, with two endpoints agreeing that no
 * contract exists, the lock tx reverted (or is unknown) and nothing of mine is pending, the row becomes ERROR with
 * one ETH_NEVER_LOCKED evidence event. Anything less leaves it alone. */
(function () {
    var ST = AX.settle, DB = AX.swapdb, H = AX.htlc, EO = AX.ethops;
    var undo = [];
    function stub(o, n, f) { undo.push([o, n, o[n]]); o[n] = f; }
    function restore() { for (var i = undo.length - 1; i >= 0; i--) undo[i][0][undo[i][1]] = undo[i][2]; undo = []; }
    var HASH = '0xfe3e2f8a0c020665f3644a294179862ebb3aeade6fed88a1afdd15bb1e0abb93';
    var ME = '0xd56f484faa44589793692ffe858078fd391af385';
    var LOCKTX = '0xbb445e4f963ee3d33f0e337f979258a9bdc20bad4cc8ff9dc67461568d6c5b7d';
    var TL = 1793308475, LATE = TL + 3600 + 600, ZERO = '0x' + '0'.repeat(768);
    var EPS = AX.ethrpc.FALLBACKS;

    /** o.ep(ep) → per-endpoint overrides: block time, tx, receipt, pending/latest nonce, contract reply, error. */
    function scenario(o) {
        var calls = [], now = o.now || LATE, rpcLog = [], seen = [];
        var row = { hash: HASH, role: o.role || 'RESPONDER', direction: 'MINIMA_TO_ERC20', myLegIsMinima: !!o.minimaLeg,
            status: o.status || 'LOCKED', sellAmount: '58.615613', sellToken: 'USDT', buyAmount: '59.20769', buyToken: 'mxUSDT',
            myTimelock: TL, contractId: '0x733bfccbc34bbf7ff184923e7c566815f57809b44bceb9ad0762c87b52ae8acf' };
        var events = o.events || [{ event: 'CPTXN_SENT', token: 'ETH:0xdac17f958d2ee523a2206206994597c13d831ec7', amount: '58.615613', note: LOCKTX, date: 1 }];
        var rpc = {
            latestBlockTimestamp: function (cb) { cb(null, now); },
            callOn: function (ep, m, p, cb) {
                rpcLog.push(ep + ' ' + m);
                if (seen.indexOf(ep) < 0) seen.push(ep);
                var x = (o.ep && o.ep(seen.indexOf(ep))) || {};   // 0 = first endpoint asked, 1 = second
                if (x.error) return cb(new Error(x.error));
                if (m === 'eth_getBlockByNumber') return cb(null, { number: '0x19ae000', timestamp: '0x' + (x.time || now).toString(16) });
                if (m === 'eth_getTransactionByHash') return cb(null, 'tx' in x ? x.tx : { blockNumber: '0x19153c9' });
                if (m === 'eth_getTransactionReceipt') return cb(null, { status: x.status || '0x0' });
                if (m === 'eth_getTransactionCount') return cb(null, p[1] === 'pending' ? (x.pending || '0xb2') : '0xb2');
                if (m === 'eth_call') return cb(null, x.contract || ZERO);
                cb(new Error('unexpected ' + m));
            }
        };
        ST._reset(); ST._setNow(function () { return now * 1000; });
        ST.configure({ rpc: rpc, ethPriv: '0x' + '11'.repeat(32), ethAddr: ME, myMinimaPk: '0xMYPK', myMinimaAddr: 'MxADDR',
            notify: function () {}, onSwapsChanged: function () { calls.push('changed'); } });
        stub(DB, 'allSwaps', function (cb) { cb(null, [row]); });
        stub(DB, 'getSwap', function (h, cb) { cb(null, row); });
        stub(DB, 'getEvents', function (h, cb) { cb(null, events); });
        stub(DB, 'getSecret', function (h, cb) { cb(null, null); });
        stub(DB, 'getRequest', function (h, cb) { cb(null, null); });
        stub(DB, 'hasEvent', function (h, ev, cb) { cb(null, events.some(function (r) { return r.event === ev; })); });
        stub(DB, 'logEvent', function (h, ev, tok, amt, note, cb) { calls.push('log:' + ev + ':' + note); events.push({ event: ev, token: tok, note: note }); cb && cb(null); });
        stub(DB, 'setSwapStatus', function (h, s, cb) { calls.push('status:' + s); row.status = s; cb && cb(null); });
        stub(DB, 'tradeByHash', function (h, cb) { cb(null, null); });
        stub(H, 'currentBlock', function (cb) { cb(null, 200); });
        stub(H, 'scanByHash', function (h, ca, d, cb) { cb(null, []); });
        stub(H, 'scanByHashDeep', function (h, ca, d, cb) { cb(null, []); });
        stub(H, 'scanByKey', function (pk, ca, d, cb) { cb(null, []); });
        stub(EO, 'make', function () { return { getContract: function (cid, cb) { cb(null, null); } }; });
        ST.poll(function () {});
        return { calls: calls, row: row, rpc: rpcLog, again: function (dt) { now += dt; ST.poll(function () {}); } };
    }
    function finalized(r) { return r.calls.indexOf('status:ERROR') >= 0; }
    function evidence(r) { return r.calls.filter(function (c) { return c.indexOf('log:ETH_NEVER_LOCKED:') === 0; }); }

    // ---- the 2026-11-05 desktop row: reverted maker lock, a week past its timelock ----
    var a = scenario({});
    var ev = evidence(a);
    T.ok('a reverted maker lock past timelock + 1h is finalized: one evidence event, then ERROR',
        ev.length === 1 && finalized(a) && a.calls.indexOf(ev[0]) < a.calls.indexOf('status:ERROR') && a.calls.indexOf('changed') >= 0);
    T.ok('the evidence names both endpoints, the full lock tx, the full contract id and the wallet',
        ev[0].indexOf(' on ' + EPS[0] + ' at block ') > 0 && ev[0].indexOf(' and ' + EPS[1] + ' at block ') > 0 && ev[0].indexOf('lock tx ' + LOCKTX + ' reverted (status 0x0)') > 0
        && ev[0].indexOf(AX.ethops.contractId(HASH)) > 0 && ev[0].indexOf(ME + ' nonce 178 with nothing pending') > 0);
    a.again(600);
    T.ok('a finalized row is not re-checked', evidence(a).length === 1);
    restore();

    T.ok('inside timelock + 1h nothing happens and no endpoint is asked', (function () {
        var r = scenario({ now: TL + 3000 }); var ok = !finalized(r) && r.rpc.length === 0; restore(); return ok; })());
    T.ok('a lock tx that succeeded refuses', (function () {
        var r = scenario({ ep: function () { return { status: '0x1' }; } }); var ok = !finalized(r); restore(); return ok; })());
    T.ok('a lock tx still pending refuses', (function () {
        var r = scenario({ ep: function () { return { tx: { blockNumber: null } }; } }); var ok = !finalized(r); restore(); return ok; })());
    T.ok('something of mine still pending refuses', (function () {
        var r = scenario({ ep: function () { return { pending: '0xb3' }; } }); var ok = !finalized(r); restore(); return ok; })());
    T.ok('a contract on the SECOND endpoint refuses', (function () {
        var r = scenario({ ep: function (ep) { return ep === 1 ? { contract: '0x' + '0'.repeat(24) + ME.slice(2) + '0'.repeat(768 - 64) } : null; } });
        var ok = !finalized(r); restore(); return ok; })());
    T.ok('a malformed getContract reply refuses', (function () {
        var r = scenario({ ep: function () { return { contract: '0x' }; } }); var ok = !finalized(r); restore(); return ok; })());
    T.ok('an endpoint error refuses', (function () {
        var r = scenario({ ep: function (ep) { return ep === 1 ? { error: 'rate limited' } : null; } }); var ok = !finalized(r); restore(); return ok; })());
    T.ok('an endpoint whose chain is not yet late refuses', (function () {
        var r = scenario({ ep: function (ep) { return ep === 1 ? { time: TL + 60 } : null; } }); var ok = !finalized(r); restore(); return ok; })());
    T.ok('a refused pass retries on the NEXT endpoint pair after the retry window', (function () {
        var r = scenario({ ep: function (ep) { return ep === 1 ? { error: 'down' } : null; } });
        var first = !finalized(r); r.again(10); var notYet = !finalized(r);
        restore(); return first && notYet; })());
    T.ok('an unknown lock tx (dropped) with no contract finalizes', (function () {
        var r = scenario({ ep: function () { return { tx: null }; } });
        var ok = finalized(r) && evidence(r)[0].indexOf('lock tx ' + LOCKTX + ' unknown') > 0; restore(); return ok; })());
    T.ok('an ETH-first initiator STARTED with no lock tx recorded finalizes', (function () {
        var r = scenario({ role: 'INITIATOR', status: 'STARTED', events: [] });
        var ok = finalized(r) && evidence(r)[0].indexOf('no lock tx recorded') > 0; restore(); return ok; })());
    T.ok('a row whose own leg is on Minima is never touched', (function () {
        var r = scenario({ minimaLeg: true }); var ok = !finalized(r) && r.rpc.length === 0; restore(); return ok; })());
    T.ok('CLAIMING is never touched', (function () {
        var r = scenario({ status: 'CLAIMING' }); var ok = !finalized(r) && r.rpc.length === 0; restore(); return ok; })());
    T.ok('already-recorded evidence finalizes without asking again or logging twice', (function () {
        var r = scenario({ events: [{ event: 'ETH_NEVER_LOCKED', token: 'ETH', note: 'earlier' }] });
        var ok = finalized(r) && evidence(r).length === 0 && r.rpc.length === 0; restore(); return ok; })());
})();
