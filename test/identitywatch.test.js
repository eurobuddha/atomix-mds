/* identitywatch — the key-vs-node verdict that halts new liabilities (mirror of native 0.1.19).
 *
 * Pins the two properties that make a halt trustworthy: it fires on a real mismatch, and it NEVER fires
 * because the node merely failed to answer. Also pins the persisted identity that closes this dapp's own
 * rotating-identity defect (getaddress returns a RANDOM default key per call).
 */
(function () {
    'use strict';
    var IW = AX.identitywatch, H = AX.htlc, M = AX.mds, E = AX.eth;

    var MY_PK = '0xBBBB';
    var MY_ETH = '0xdc0d39006df40f0766d468869b0fbec65d6c0b53';
    var NEW_ETH = '0x765a3381e33a09ee3109f089a4944dd947d3f792';

    var undo = [];
    function stub(o, n, f) { undo.push([o, n, o[n]]); o[n] = f; }
    function restore() { for (var i = undo.length - 1; i >= 0; i--) undo[i][0][undo[i][1]] = undo[i][2]; undo = []; }

    function ctx() { return { htlc: { publickey: MY_PK, miniaddress: 'MxME' }, eth: { address: MY_ETH } }; }

    /** keys: array returned by loadKeys (already normKey form) · seed: seedrandom reply or null to fail */
    function wire(keys, ethAddr) {
        stub(H, 'loadKeys', function (cb) { cb(keys === null ? new Error('busy') : null, keys); });
        stub(M, 'cmdR', function (cmd, cb) {
            if (String(cmd).indexOf('seedrandom') === 0)
                return ethAddr === null ? cb(new Error('busy')) : cb(null, { seedrandom: '0x' + '11'.repeat(32) });
            cb(null, {});
        });
        // addressFromPriv is what turns the seedrandom hash into an address — stub it to the address under test
        stub(E, 'addressFromPriv', function () { return ethAddr; });
    }

    try {
        // ---------- matching keys: silent ----------
        IW._reset(); wire([H.normKey(MY_PK)], MY_ETH);
        IW.check(ctx(), function () {});
        T.eq('match → not halted', IW.halted(), false);
        restore();

        // ---------- ETH wallet went stale under us (the 2026-08-06 case) ----------
        IW._reset(); wire([H.normKey(MY_PK)], NEW_ETH);
        IW.check(ctx(), function () {});
        T.eq('stale ETH → halted', IW.halted(), true);
        T.eq('stale ETH flagged', IW.verdict().ethMismatch, true);
        T.eq('minima still fine', IW.verdict().minimaMismatch, false);
        T.eq('stale address recorded', IW.verdict().staleEth, MY_ETH);
        T.eq('node address recorded', IW.verdict().nodeEth, NEW_ETH);
        restore();

        // ---------- orphaned Minima key ----------
        IW._reset(); wire(['AAAA'], MY_ETH);
        IW.check(ctx(), function () {});
        T.eq('orphaned key → halted', IW.halted(), true);
        T.eq('orphan flagged', IW.verdict().minimaMismatch, true);
        T.eq('orphan recorded', IW.verdict().orphanedPk, MY_PK);
        restore();

        // ---------- a node that cannot answer must NEVER halt a healthy install ----------
        IW._reset(); wire([], null);
        IW.check(ctx(), function () {});
        T.eq('empty keys + failed seedrandom → NOT halted', IW.halted(), false);
        restore();

        IW._reset(); wire(null, null);
        IW.check(ctx(), function () {});
        T.eq('loadKeys error → NOT halted', IW.halted(), false);
        restore();

        // ---------- throttle ----------
        IW._reset(); wire([H.normKey(MY_PK)], MY_ETH);
        IW.check(ctx(), function () {});
        restore();
        wire([H.normKey(MY_PK)], NEW_ETH);          // reseed lands immediately after
        IW.check(ctx(), function () {});
        T.eq('inside the window → no re-probe', IW.halted(), false);
        IW.forceNext();
        IW.check(ctx(), function () {});
        T.eq('window forced → mismatch seen', IW.halted(), true);
        restore();

        // ---------- the halt reaches the responder (the only place we commit fresh money) ----------
        IW._reset(); IW._setMismatch(false, true);
        AX.responder.configure({ rpc: {}, ethPriv: '0x' + '11'.repeat(32), ethAddr: MY_ETH,
            myMinimaPk: MY_PK, myMinimaAddr: 'MxME' });
        T.eq('halted → responder refuses new counter-legs', AX.responder.ready(), false);
        IW._reset();
        T.eq('cleared → responder available again', AX.responder.ready(), true);
        restore();

        // ---------- the swap identity is PERSISTED (closes the rotating-identity defect) ----------
        IW._reset();
        var stored = {}, getaddressCalls = 0;
        stub(M, 'kvGet', function (k, d, cb) { cb(stored[k] === undefined ? d : stored[k]); });
        stub(M, 'kvSet', function (k, v, cb) { stored[k] = v; cb && cb(null); });
        stub(M, 'cmdR', function (cmd, cb) {
            if (String(cmd).indexOf('newscript') === 0) return cb(null, {});
            if (String(cmd).indexOf('getaddress') === 0) {
                getaddressCalls++;
                return cb(null, { miniaddress: 'MxPICK' + getaddressCalls, address: '0xA' + getaddressCalls,
                                  publickey: '0xPK' + getaddressCalls });
            }
            cb(null, {});
        });
        stub(H, 'loadKeys', function (cb) { cb(null, ['PK1']); });
        var first = null, second = null;
        H.setup(function (e, info) { first = info; });
        H.setup(function (e, info) { second = info; });
        T.eq('first boot picks an identity', getaddressCalls, 1);
        T.eq('second boot REUSES it (no rotation)', getaddressCalls, 1);
        T.eq('same publickey across boots', second && second.publickey, first && first.publickey);
        restore();
    } finally { restore(); }
})();
