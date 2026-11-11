// Port 253 (mirror of native MinimaHtlc 0.2.32): every new lock names the RECEIVER's address — the CLEAN address of
// RETURN SIGNEDBY(<port 4 key>) — so the receiver's node tracks the lock and sees its claim or refund (no phantom).
(function () {
    var H = AX.htlc, M = AX.mds, saved = M.cmdR, savedCmd = M.cmd, commands = [], answer = 'clean';
    var PK = '0x6FFE1A8B2B1944C71A4A51B331F1C8857AC33781E1A02E78A6DAF9467054316D';
    var ADDR = '0xD49510A2F1D9FD73E9BB558A446A3FDC6663F876C9A13D4821F09CAFC805BAC9';   // dev node, 11 Nov 2026
    var RAW_LOWER = '0xA2AA7F6B374028A97CC36E18057582C1A784DD87911F4B212EE1C71DEB1AE885';
    var valid = { valid: { basic: true, mmrproofs: true, scripts: 1 }, validamounts: true, allsignaturesvalid: true, validtransaction: true };
    function cov(c) { var v13 = String(c).indexOf(H.ADDRESS_V13) >= 0; return v13 ? { miniaddress: H.ADDRESS_V13, address: H.ADDRESS_V13_HEX } : { miniaddress: H.ADDRESS, address: H.ADDRESS_HEX }; }
    M.cmd = function () {};
    M.cmdR = function (c, done) {
        commands.push(c);
        var r;
        if (c.indexOf('runscript ') === 0) {
            if (answer === 'fail') return done(new Error('runscript refused'));
            var lower = c.indexOf(PK.slice(2).toLowerCase()) > 0;
            r = { script: { address: lower ? RAW_LOWER : ADDR }, clean: { address: answer === 'junk' ? 'nope' : ADDR } };
        } else r = c.indexOf('txncheck ') === 0 ? valid : c.indexOf('scripts address:') === 0 ? cov(c) : { txpowid: '0x' + '55'.repeat(32) };
        done(null, r, { status: true, response: r });
    };
    function params(pk) { return { amount: '1', coinids: ['0xC1'], totalSelected: '2', requestAmount: '1', reqToken: 'minima', receiverPubkey: pk,
        ownerEthKey: '0xAB', hashlock: '0xCD', timelockBlock: 987654, otc: 'FALSE', myPubkey: '0x0BC0FFEE', tokenId: '0x00', myAddress: 'MxADDR' }; }
    function sendState() { var s = commands.filter(function (c) { return c.indexOf('send ') === 0; })[0]; return JSON.parse(s.slice(s.indexOf('state:') + 6, s.indexOf(' tokenid:'))); }
    try {
        H.lock(params(PK), function () {});
        T.ok('253: lookup asks for RETURN SIGNEDBY(receiver key)', commands[0] === 'runscript script:"RETURN SIGNEDBY(' + PK + ')"');
        T.eq('253: send lock carries the receiver address', sendState()['253'], ADDR);
        commands = []; H.lockFromCoins(params(PK), function () {});
        T.ok('253: coin lock carries the receiver address', commands.some(function (c) { return / port:253 value:/.test(c) && c.slice(-ADDR.length) === ADDR; }));
        commands = []; H.lockFromCoins(params('0x' + PK.slice(2).toLowerCase()), function () {});
        T.ok('253: a lowercase key (off Ethereum) still gives the tracked CLEAN address',
            commands.some(function (c) { return c.slice(-ADDR.length) === ADDR && c.indexOf('port:253') > 0; }) && !commands.some(function (c) { return c.indexOf(RAW_LOWER) >= 0; }));
        answer = 'fail'; commands = []; H.lock(params(PK), function () {});
        T.ok('253: a node that cannot say leaves the send lock as before', !('253' in sendState()));
        answer = 'junk'; commands = []; H.lockFromCoins(params(PK), function () {});
        T.ok('253: a malformed answer leaves the coin lock as before', !commands.some(function (c) { return c.indexOf('port:253') > 0; })
            && commands.some(function (c) { return c.indexOf('txnpost ') === 0; }));
    } finally { M.cmdR = saved; M.cmd = savedCmd; }
})();
