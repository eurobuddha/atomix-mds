/* Duplicate state ports (review 7 Nov, mirror of APK 0.2.8). Proven on a -test chain: a coin landed with port 3 =
 * [1, 9]; a script asserting PREVSTATE(3) EQ 1 spent it, EQ 9 failed; simplestate showed 9. KISS reads the FIRST entry,
 * so fund-deciding scans ask for the state ARRAY and stateAt returns the first match. */
(function () {
    var H = AX.htlc, M = AX.mds;
    var undo = [];
    function stub(o, n, f) { undo.push([o, n, o[n]]); o[n] = f; }
    try {
        var coin = { state: [{ port: 3, type: 1, data: '100' }, { port: 3, type: 1, data: '999999' }] };
        T.eq('stateAt takes the FIRST entry of a duplicated port, as KISS does', H.stateAt(coin, 3), '100');
        var cmds = [];
        stub(M, 'cmd', function (c, cb) { cmds.push(c); cb && cb({ status: true, response: [] }); });
        stub(M, 'cmdR', function (c, cb) { cmds.push(c); cb(null, []); });
        H.scanByHash('0x' + 'AB'.repeat(32), 1, 64, function () {});
        H.scanAllHtlcCoins(1, 64, function () {});
        H.scanNotifySecret('0x' + 'AB'.repeat(32), 64, function () {});
        var coinsCmds = cmds.filter(function (c) { return c.indexOf('coins ') === 0; });
        T.ok('the fund-deciding scans issued coins commands', coinsCmds.length >= 3);
        T.ok('no fund-deciding scan asks for simplestate', coinsCmds.every(function (c) { return c.indexOf('simplestate') < 0; }));
    } finally {
        for (var i = undo.length - 1; i >= 0; i--) undo[i][0][undo[i][1]] = undo[i][2];
    }
})();
/* 0.1.54 (mirror of APK 0.2.9): a lock whose own script cannot run is never answered or claimed. */
(function () {
    var H = AX.htlc, K = '0x' + '11'.repeat(32), C = '0x' + '22'.repeat(32), HS = '0x' + 'AB'.repeat(32);
    function coin(p0, p3, six) {
        var v = [p0, '1', '0xdAC17F958D2ee523a2206206994597C13D831ec7', p3, C, HS, '0x01'], st = [];
        for (var i = 0; i < 7; i++) if (i !== 6 || six) st.push({ port: i, data: v[i] });
        return { state: st };
    }
    T.ok('a well-formed lock is spendable', H.lockSpendable(coin(K, '2000000', true)));
    T.ok('a NUMBER owner is refused', !H.lockSpendable(coin('5', '2000000', true)));
    T.ok('a STRING owner is refused', !H.lockSpendable(coin('[' + K + ']', '2000000', true)));
    T.ok('a HEX timelock is refused', !H.lockSpendable(coin(K, '0x1E8480', true)));
    T.ok('a missing port is refused', !H.lockSpendable(coin(K, '2000000', false)));
})();
