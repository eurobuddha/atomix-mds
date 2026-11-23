/* 0.1.61 — the node splits every command on ";" (even inside quotes) and runs each piece. A stand-in node that splits
 * exactly so (StringTokenizer on ";", each piece trimmed) records what it would run: nothing a peer or a coin's state
 * supplies may become a command, every refusal is logged, and the HTLC validators never trim what they let through. */
(function () {
    var saved = globalThis.MDS, ran = [], logs = [];
    function pieces(t) { return String(t).split(';').map(function (s) { return s.replace(/^[\u0000- ]+|[\u0000- ]+$/g, ''); }).filter(Boolean); }
    var ATT = '0x' + '29A'.padStart(64, '0'), SEND = 'send amount:1000 address:' + ATT + ' tokenid:0x00';
    try {
        globalThis.MDS = { log: function (m) { logs.push(m); }, cmd: function (c, cb) { pieces(c).forEach(function (p) { ran.push(p); }); cb({ status: true, response: {} }); } };
        var bad = ['runscript script:"RETURN SIGNEDBY(0x01;' + SEND + ')"', 'coins\n' + SEND, 'block\r', 'block\u0000'], refused = 0;
        bad.forEach(function (q) { AX.mds.cmd(q, function (r) { if (r && r.status === false) refused++; }); AX.mds.cmdR(q, function (e) { if (e) refused++; }); });
        T.ok('inject: ";", CR, LF, NUL refused by cmd and cmdR', refused === 8);
        T.ok('inject: nothing reached the stand-in node', ran.length === 0);
        T.ok('inject: every refusal is logged as SECURITY', logs.filter(function (l) { return l.indexOf('SECURITY') === 0; }).length === 8);
        // a coin at the anyone-can-write HTLC address whose state key carries a trailing space / line break: the old
        // trimmed isHex let it through and a claim was built from it; now the claim is refused before ANY command
        var hex = '0x' + 'AB'.repeat(32);
        [hex + ' ', ' ' + hex, hex + '\n', hex + ' ' + SEND].forEach(function (k, i) {
            ran.length = 0; var err = null;
            var coin = { coinid: hex, tokenid: '0x00', amount: '1', state: [{ port: 0, data: hex }, { port: 4, data: k }] };
            AX.htlc.claim(coin, hex, hex, hex, function (e) { err = e; });
            T.ok('inject: claim refuses a state key with white space #' + i, err && /non-hex coin state key/.test(err.message) && ran.length === 0);
        });
    } finally { globalThis.MDS = saved; }
})();
