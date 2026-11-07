/* HTLC v1.3 (review 7 Nov, mirror of APK 0.2.6): v1.2 accepts a secret of any length, the Ethereum vault only 32 bytes.
 * v1.3 adds one line; the maker's counter-leg of a USDT-paid take locks there, only for a taker that said htlc:'1.3';
 * every scan covers both addresses; asks a v1.3 maker answers travel as bal.m13 so older clients never see them.
 * (Script → address was checked on a node: runscript gives ADDRESS_V13; 32 bytes claims, 31 and 40 are refused.) */
(function () {
    var H = AX.htlc, O = AX.order, B = AX.book, R = AX.responder, DB = AX.swapdb, EO = AX.ethops, D = AX.dec, TK = AX.take, M = AX.mds;
    var undo = [];
    function stub(o, n, f) { undo.push([o, n, o[n]]); o[n] = f; }
    function restore() { for (var i = undo.length - 1; i >= 0; i--) undo[i][0][undo[i][1]] = undo[i][2]; undo = []; }
    function H32(b) { return '0x' + b.repeat(32); }
    try {
        // ---- the script ----
        T.eq('v1.3 = v1.2 + the length check only',
            H.SCRIPT_V13.replace('LET version=1.3 ', '').replace('ASSERT LEN(secret) EQ 32 ', ''), H.SCRIPT.replace('LET version=1.2 ', ''));
        T.ok('the check precedes SHA2(secret); the refund branch precedes the check',
            H.SCRIPT_V13.indexOf('LEN(secret)') < H.SCRIPT_V13.indexOf('SHA2(secret)')
            && H.SCRIPT_V13.indexOf('SIGNEDBY(owner) AND (@BLOCK GT timelock)') < H.SCRIPT_V13.indexOf('LEN(secret)'));
        T.ok('both addresses are HTLC addresses', H.isHtlcAddress(H.ADDRESS) && H.isHtlcAddress(H.ADDRESS_V13) && H.isHtlcAddress(H.ADDRESS_V13_HEX) && !H.isHtlcAddress('MxOTHER'));

        // ---- both covenants registered, verified per address ----
        var cmds = [], rows = {};
        stub(M, 'cmd', function (c, cb) { cmds.push(c); cb && cb({ status: true, response: [] }); });
        stub(M, 'cmdR', function (c, cb) {
            cmds.push(c);
            if (c.indexOf('scripts address:') === 0) { var a = c.slice(16); return rows[a] ? cb(null, rows[a]) : cb(new Error('not found'), null, { status: false }); }
            if (c.indexOf('newscript') === 0) {
                var v13 = c.indexOf('version=1.3') >= 0, r = v13 ? { miniaddress: H.ADDRESS_V13, address: H.ADDRESS_V13_HEX } : { miniaddress: H.ADDRESS, address: H.ADDRESS_HEX };
                rows[r.miniaddress] = r; return cb(null, r);
            }
            if (c.indexOf('coins ') === 0) return cb(null, [{ coinid: c.indexOf(H.ADDRESS_V13) >= 0 ? '0xV13' : '0xV12' }]);
            cb(null, { txpowid: '0xT' });
        });
        var reg = null;
        H.ensureScript(function (e, now) { reg = { e: e, now: now }; });
        T.ok('ensureScript registers BOTH covenants', reg && !reg.e && reg.now === true
            && cmds.filter(function (c) { return c.indexOf('newscript') === 0; }).length === 2);
        cmds = []; H.ensureScript(function () {});
        T.eq('…and leaves them alone once both rows are there', cmds.filter(function (c) { return c.indexOf('newscript') === 0; }).length, 0);

        // ---- settlement scans read both addresses ----
        var got = null; cmds = [];
        H.scanByHash(H32('ab'), 1, 256, function (e, a) { got = a; });
        T.eq('scanByHash merges the rows of both addresses', got.map(function (c) { return c.coinid; }), ['0xV12', '0xV13']);
        T.ok('…coinnotify-adding each first', cmds.indexOf('coinnotify action:add address:' + H.ADDRESS) >= 0 && cmds.indexOf('coinnotify action:add address:' + H.ADDRESS_V13) >= 0);
        got = null; H.scanByHashDeep(H32('ab'), 2, 4096, function (e, a) { got = a; });
        T.eq('scanByHashDeep reads both', got.length, 2);
        got = null; H.scanByKey(H32('cd'), 2, 256, function (e, a) { got = a; });
        T.eq('scanByKey reads both', got.length, 2);
        restore();
        stub(M, 'cmd', function (c, cb) { cb && cb({ status: true, response: [] }); });
        stub(M, 'cmdR', function (c, cb) { if (c.indexOf(H.ADDRESS_V13) >= 0) return cb(new Error('node busy')); cb(null, [{ coinid: '0xV12' }]); });
        var res = null; H.scanByHash(H32('ab'), 1, 256, function (e, a) { res = { e: e, a: a }; });
        T.ok('a failed read of either address is an error, never half a picture', res && res.e && res.a.length === 0);
        restore();

        // ---- the order wire ----
        var o = O.make(); o.minimaAvail = 50; o.usdtAvail = 10; var p = O.pair(true, 1.01, 0.99, 1); p.asks = [O.level(1.01, 10)]; o.pairs.USDT = p;
        o.asksNeedHtlc13 = true;
        var j = O.toJson(o);
        T.eq('v1.3 maker: bal.m is 0, the ask balance is bal.m13', [j.bal.m, j.bal.m13, j.bal.u], [0, 50, 10]);
        var seen = O.fromJson(JSON.parse(JSON.stringify(j)));
        T.ok('a new client reads m13', seen.asksNeedHtlc13 === true && seen.minimaAvail === 50);
        var old = JSON.parse(JSON.stringify(j)); delete old.bal.m13;
        T.eq('an older client sees no ask capacity', B.levelCap(O.fromJson(old), O.level(1.01, 10), false), 0);
        o.asksNeedHtlc13 = false;
        T.ok('a maker not requiring v1.3 publishes as before', O.toJson(o).bal.m === 50 && O.toJson(o).bal.m13 === undefined);

        // ---- the taker's handshake says it ----
        var sealed = null;
        stub(AX.identity, 'seal', function (pub, bytes) { sealed = JSON.parse(new TextDecoder().decode(bytes)); return '0xBLOB'; });
        stub(M, 'cmdR', function (c, cb) { cb(null, {}); });
        try { TK.send({ seal: function (pub, bytes) { sealed = JSON.parse(new TextDecoder().decode(bytes)); return '0xBLOB'; } }, 'MAKER', 'ME', H32('ab'), function () {}); } catch (e) { }
        T.ok('the taker handshake carries htlc:"1.3"', TK.HTLC === '1.3');
        restore();

        // ---- the maker gate ----
        var evs = [], swaps = {}, NOW = 2000000000;
        stub(DB, 'getEvents', function (h, cb) { cb(null, evs.filter(function (e) { return e.hash === DB.norm(h); })); });
        stub(DB, 'hasEvent', function (h, ev, cb) { cb(null, evs.some(function (e) { return e.hash === DB.norm(h) && e.event === ev; })); });
        stub(DB, 'logEvent', function (h, ev, t, a, note, cb) { evs.push({ hash: DB.norm(h), event: ev, note: note }); cb && cb(null); });
        stub(DB, 'getSwap', function (h, cb) { cb(null, swaps[DB.norm(h)] || null); });
        stub(DB, 'upsertSwap', function (s, cb) { cb && cb(null); });
        stub(DB, 'deleteSwap', function (h, cb) { cb && cb(null); });
        var contracts = {};
        function contract(h) {
            var c = { hashlock: h, contractId: EO.contractId(h), receiver: '0xME', timelock: NOW + 7000, tokenContract: EO.NET.usdt,
                requestAmount: D.parseUnits('50', 18), amount: D.parseUnits('51', 6), minimaPublicKey: '0xTAKERPK', withdrawn: false, refunded: false };
            contracts[c.contractId] = c; return c;
        }
        stub(EO, 'make', function () { return { getContract: function (cid, cb) { cb(null, contracts[cid] || null); } }; });
        stub(H, 'myFreeCoins', function (tok, cb) { cb(null, [{ coinid: '0xC1', tokenamount: '500' }]); });
        var locks = [];
        stub(H, 'lockFromCoins', function (args, cb) { locks.push(args); });
        var wasXcheck = AX.settle.secondEndpointAgrees; AX.settle.secondEndpointAgrees = function (cid, c, cb) { cb(true); };
        var wasPaused = H.ETH_FIRST_PAUSED; H.ETH_FIRST_PAUSED = true;
        var po = O.make(), pp = O.pair(true, 0, 0, 1); pp.asks = [O.level(1.01, 100)]; po.pairs.USDT = pp;
        R._reset();
        R.configure({ rpc: { latestBlockTimestamp: function (cb) { cb(null, NOW); } }, ethPriv: H32('11'), ethAddr: '0xME',
            myMinimaPk: '0xMYPK', myMinimaAddr: 'MxADDR', myIdentity: AX.identity.fromSeed('h13-maker', 'usdtswap'),
            getOrder: function () { return po; }, notify: function () {}, onSwapsChanged: function () {} });
        try {
            var hOld = H32('e1'); contract(hOld);
            R.processIncomingBuy(hOld, 100, NOW, function () {});
            T.ok('a USDT-paid take from an old taker is declined, with the reason',
                locks.length === 0 && evs.some(function (e) { return e.hash === DB.norm(hOld) && /HTLC v1\.3/.test(e.note || ''); }));
            var hNew = H32('e2'); contract(hNew); R._htlc13()[DB.norm(hNew)] = true;
            R.processIncomingBuy(hNew, 100, NOW, function () {});
            T.ok('a v1.3 taker gets a counter-leg locked at v1.3', locks.length === 1 && locks[0].htlc13 === true && locks[0].hashlock === hNew);
        } finally {
            H.ETH_FIRST_PAUSED = wasPaused; AX.settle.secondEndpointAgrees = wasXcheck; R._reset(); R.configure(null);
        }
    } finally { restore(); }
})();
