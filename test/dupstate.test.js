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
