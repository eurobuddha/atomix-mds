/* identitywatch — the key-vs-node verdict that halts new liabilities (mirror of native 0.1.19).
 *
 * Pins the two properties that make a halt trustworthy: it fires on a real mismatch, and it NEVER fires
 * because the node merely failed to answer. Also pins the persisted identity that closes this dapp's own
 * rotating-identity defect (getaddress returns a RANDOM default key per call).
 */
(function () {
    function cov(c) { var v13 = String(c).indexOf('version=1.3') >= 0 || String(c).indexOf(AX.htlc.ADDRESS_V13) >= 0; return v13 ? { miniaddress: AX.htlc.ADDRESS_V13, address: AX.htlc.ADDRESS_V13_HEX } : { miniaddress: AX.htlc.ADDRESS, address: AX.htlc.ADDRESS_HEX }; }   // the covenant a scripts/newscript command names
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
            if (String(cmd).indexOf('scripts address:') === 0) return cb(new Error('cmd failed: not found'), null, { status: false });
            if (String(cmd).indexOf('newscript') === 0) return cb(null, cov(cmd));   // the node confirms the address it computed
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

        // ---------- 15 Nov 2026: a healthy install halted on a short key list. An INCOMPLETE list never halts ----------
        var REAL = H.normKey('0x172215A51CF23DD5F196516A13E95EB1CAA47482EC5D6F46A8BC54460A5AE202');
        function list(n, withMine, total) {      // what the real loader returns: array + .total + .complete
            var a = []; for (var i = 0; i < n; i++) a.push(('A' + i + '0'.repeat(64)).slice(0, 64));
            if (withMine) a[0] = REAL;
            a.total = total; a.complete = a.length > 0 && (total === null || a.length >= total);
            return a;
        }
        function ctxReal() { return { htlc: { publickey: '0x172215A51CF23DD5F196516A13E95EB1CAA47482EC5D6F46A8BC54460A5AE202' }, eth: { address: MY_ETH } }; }
        function seq(lists) { var i = 0; stub(H, 'loadKeys', function (cb) { var l = lists[Math.min(i++, lists.length - 1)]; cb(l === null ? new Error('busy') : null, l); }); }

        IW._reset(); wire([], MY_ETH); seq([list(40, false, 80)]);
        IW.check(ctxReal(), function () {});
        T.eq('40 of 80 keys without ours → NOT halted (cannot verify)', IW.halted(), false);
        restore();

        IW._reset(); wire([], MY_ETH); seq([list(80, false, 80), list(80, true, 80)]);
        IW.check(ctxReal(), function () {});
        T.eq('one complete read lacks the key, the second has it → NOT halted', IW.halted(), false);
        restore();

        IW._reset(); wire([], MY_ETH); seq([list(80, false, 80), list(40, false, 80)]);
        IW.check(ctxReal(), function () {});
        T.eq('second read incomplete → verdict untouched, NOT halted', IW.halted(), false);
        restore();

        IW._reset(); wire([], MY_ETH); seq([list(80, false, 80), list(80, false, 80)]);
        IW.check(ctxReal(), function () {});
        T.eq('two complete reads without the key → halted', IW.halted(), true);
        T.eq('the full key is recorded', IW.verdict().orphanedPk, '0x172215A51CF23DD5F196516A13E95EB1CAA47482EC5D6F46A8BC54460A5AE202');
        restore();

        // the real loader: a string reply or a short reply is never complete
        var loaded = null;
        stub(M, 'cmdR', function (cmd, cb) { cb(null, 'keys unavailable'); });
        H.loadKeys(function (e, k) { loaded = k; });
        T.eq('string reply → empty, not a key list', loaded.length, 0);
        T.eq('string reply → not complete', loaded.complete, false);
        restore();
        stub(M, 'cmdR', function (cmd, cb) { cb(null, { keys: [{ publickey: '0x' + REAL }], total: 80, maxuses: 7745 }); });
        H.loadKeys(function (e, k) { loaded = k; });
        T.eq('1 of total 80 → not complete', loaded.complete, false);
        restore();
        stub(M, 'cmdR', function (cmd, cb) { cb(null, { keys: [{ publickey: '0x' + REAL }], total: 1 }); });
        H.loadKeys(function (e, k) { loaded = k; });
        T.eq('1 of total 1 → complete', loaded.complete, true);
        restore();

        // ETH: one differing derivation then the right one → not halted
        IW._reset();
        stub(H, 'loadKeys', function (cb) { cb(null, [H.normKey(MY_PK)]); });
        var n = 0;
        stub(M, 'cmdR', function (cmd, cb) { cb(null, { seedrandom: '0x' + '11'.repeat(32) }); });
        stub(E, 'addressFromPriv', function () { return n++ === 0 ? NEW_ETH : MY_ETH; });
        IW.check(ctx(), function () {});
        T.eq('ETH differs once, then matches → NOT halted', IW.halted(), false);
        restore();
    } finally { restore(); }
})();
