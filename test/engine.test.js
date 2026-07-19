/* engine — taker start paths: record-before-broadcast ordering, lock/newContract args, allowance gate, confirmMyLock. */
(function () {
    var E = AX.engine, DB = AX.swapdb, H = AX.htlc, EO = AX.ethops, TR = AX.trading;

    // stub/restore helpers — engine captured these object refs at load, so we MUTATE methods (not replace objects).
    var undo = [];
    function stub(obj, name, fn) { undo.push([obj, name, obj[name]]); obj[name] = fn; }
    function restore() { for (var i = undo.length - 1; i >= 0; i--) undo[i][0][undo[i][1]] = undo[i][2]; undo = []; }

    var maker = { minimaPublicKey: '0xMAKERMPK', ethAddress: '0xMAKERETH', commsPublicId: '0x' + 'aa'.repeat(64) };
    var HASH = '0x' + '22'.repeat(32);   // must be valid hex (contractId hashes it)

    try {
        // ---------- startSell (MINIMA_TO_ERC20) ----------
        E.configure({ rpc: { latestBlockTimestamp: function (cb) { cb(null, 1700000000); } },
            ethPriv: '0x' + '11'.repeat(32), ethAddr: '0xMYETH', myMinimaPk: '0xMYPK' });
        var log = [], lockParams = null;
        stub(DB, 'insertSecret', function (h, s, cb) { log.push('secret'); cb(null, true); });
        stub(DB, 'insertMyHtlc', function (h, a, t, cb) { log.push('myhtlc'); cb(null); });
        stub(DB, 'upsertSwap', function (sw, cb) { log.push('upsert'); log._swap = sw; cb(null); });
        stub(DB, 'logEvent', function (h, e, t, a, x, cb) { log.push('event:' + e); cb(null); });
        stub(H, 'generateSecret', function (cb) { cb(null, { secret: '0xSEC', hash: HASH }); });
        stub(H, 'currentBlock', function (cb) { cb(null, 1000); });
        stub(H, 'lock', function (p, cb) {
            lockParams = p; log.push('lock');
            T.eq('SELL record-before-broadcast', log.slice(0, 3), ['secret', 'myhtlc', 'upsert']);
            cb(null, '0xTXPOW');
        });
        var sellDone = null;
        E.startSell(maker, '1.5', 'USDT', '1.485', false, function (e, hash) { sellDone = { e: e, hash: hash }; });
        T.ok('startSell ok', sellDone && !sellDone.e && sellDone.hash === HASH);
        T.eq('SELL op order', log.slice(), ['secret', 'myhtlc', 'upsert', 'lock', 'event:HTLC_STARTED']);
        T.eq('SELL lock amount/req', [lockParams.amount, lockParams.requestAmount], ['1.5', '1.485']);
        T.eq('SELL lock reqToken=USDT addr', lockParams.reqToken, EO.NET.usdt);
        T.eq('SELL lock receiver=maker mpk', lockParams.receiverPubkey, '0xMAKERMPK');
        T.eq('SELL lock owner-eth', lockParams.ownerEthKey, '0xMYETH');
        T.eq('SELL lock timelock = block+144', lockParams.timelockBlock, 1144);
        T.eq('SELL lock myPubkey', lockParams.myPubkey, '0xMYPK');
        T.eq('SELL lock tokenId = active(mxUSDT)', lockParams.tokenId, TR.MXUSDT.tokenId);
        T.eq('SELL swap direction + legIsMinima', [log._swap.direction, log._swap.myLegIsMinima], ['MINIMA_TO_ERC20', true]);
        restore();

        // ---------- startBuy (ERC20_TO_MINIMA), allowance already MAX ----------
        E.configure({ rpc: { latestBlockTimestamp: function (cb) { cb(null, 1700000000); } },
            ethPriv: '0x' + '11'.repeat(32), ethAddr: '0xMYETH', myMinimaPk: '0xMYPK' });
        E._resetApprovals();
        var blog = [], ncArgs = null;
        stub(DB, 'insertSecret', function (h, s, cb) { blog.push('secret'); cb(null, true); });
        stub(DB, 'insertMyHtlc', function (h, a, t, cb) { blog.push('myhtlc:' + a + ':' + t); cb(null); });
        stub(DB, 'upsertSwap', function (sw, cb) { blog.push('upsert'); blog._swap = sw; cb(null); });
        stub(DB, 'logEvent', function (h, e, t, a, x, cb) { blog.push('event'); cb(null); });
        stub(H, 'generateSecret', function (cb) { cb(null, { secret: '0xSEC', hash: HASH }); });
        stub(EO, 'make', function () {
            return {
                allowance: function (t, cb) { cb(null, E.MAX_UINT); },   // already approved → one-shot lock
                newContract: function (mpk, recv, hash, tl, tok, sell, req, otc, cb) {
                    ncArgs = { mpk: mpk, recv: recv, hash: hash, tl: tl, tok: tok, sell: sell, req: req };
                    T.eq('BUY record-before-broadcast', blog.slice(), ['secret', 'myhtlc:4.95:minima', 'upsert']);
                    cb(null, '0xETHTX');
                }
            };
        });
        var buyDone = null;
        E.startBuy(maker, 'USDT', '5', '4.95', false, function (e, hash) { buyDone = { e: e, hash: hash }; });
        T.ok('startBuy ok', buyDone && !buyDone.e && buyDone.hash === HASH);
        T.eq('BUY op order', blog.slice(), ['secret', 'myhtlc:4.95:minima', 'upsert', 'event']);
        T.eq('BUY newContract sender=myMinimaPk', ncArgs.mpk, '0xMYPK');
        T.eq('BUY newContract receiver=maker eth', ncArgs.recv, '0xMAKERETH');
        T.eq('BUY newContract sellRaw 5 USDT @6dp', String(ncArgs.sell), '5000000');
        T.eq('BUY newContract reqRaw 4.95 @18dp', String(ncArgs.req), '4950000000000000000');
        T.eq('BUY newContract timelock = chain+7200', String(ncArgs.tl), '1700007200');
        T.eq('BUY swap contractId = sha256(hash)', blog._swap.contractId, EO.contractId(HASH));
        T.eq('BUY swap legIsMinima false', blog._swap.myLegIsMinima, false);
        restore();

        // ---------- startBuy allowance short → approve submitted, retry asked ----------
        E.configure({ rpc: { latestBlockTimestamp: function (cb) { cb(null, 1700000000); } },
            ethPriv: '0x' + '11'.repeat(32), ethAddr: '0xMYETH', myMinimaPk: '0xMYPK' });
        E._resetApprovals();
        var approved = null;
        stub(EO, 'make', function () {
            return {
                allowance: function (t, cb) { cb(null, 0n); },
                approve: function (t, amt, cb) { approved = String(amt); cb(null, '0xAPPROVE'); }
            };
        });
        var shortDone = null;
        E.startBuy(maker, 'USDT', '5', '4.95', false, function (e) { shortDone = e; });
        T.ok('allowance short → retry error', shortDone && /Approving USDT/.test(shortDone.message));
        T.eq('allowance short fires MAX approve', approved, String(E.MAX_UINT));
        restore();

        // ---------- confirmMyLock ----------
        E.configure({ rpc: {}, ethPriv: '0x' + '11'.repeat(32), ethAddr: '0xMYETH', myMinimaPk: '0xMYPK' });
        stub(H, 'scanByHash', function (hash, ca, depth, cb) { cb(null, [{ state: { '0': '0xMYPK', '5': HASH } }]); });
        E.confirmMyLock(HASH, true, function (found) { T.eq('confirm SELL lock present', found, true); });
        restore();
        stub(H, 'scanByHash', function (hash, ca, depth, cb) { cb(null, []); });
        E.confirmMyLock(HASH, true, function (found) { T.eq('confirm SELL lock absent', found, false); });
        restore();
        stub(EO, 'make', function () { return { getContract: function (cid, cb) { cb(null, { amount: 5000000n }); } }; });
        E.confirmMyLock(HASH, false, function (found) { T.eq('confirm BUY lock present', found, true); });
        restore();
        stub(EO, 'make', function () { return { getContract: function (cid, cb) { cb(null, { amount: 0n }); } }; });
        E.confirmMyLock(HASH, false, function (found) { T.eq('confirm BUY lock zero-amount → false', found, false); });
        restore();
    } finally { restore(); }
})();
