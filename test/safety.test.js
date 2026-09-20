(function () {
    var H = AX.htlc, M = AX.mds, saved = M.cmdR, deleted = M.cmd, commands = [], failure = '', successes = 0;
    var balance = { coins: '54', sendable: '100', confirmed: '100', unconfirmed: '0' };
    var valid = { valid: { basic: true, mmrproofs: true, scripts: 1 }, validamounts: true, allsignaturesvalid: true, validtransaction: true };
    function cb(e) { if (e) failure = e.message; else successes++; }
    function reset() { commands = []; failure = ''; successes = 0; }
    M.cmd = function () {};
    M.cmdR = function (command, done) {
        commands.push(command);
        var response = command.indexOf('balance ') === 0 ? balance : command.indexOf('coins ') === 0 ? [] : command.indexOf('txncheck ') === 0 ? valid
            : command.indexOf('scripts address:') === 0 ? { miniaddress: H.ADDRESS, address: H.ADDRESS_HEX } : { txpowid: '0x' + '55'.repeat(32) };
        done(null, response, { status: true, response: response });
    };
    try {
        H.myFreeCoins(AX.trading.USDT_TOKENID, cb);
        T.ok('oversize wallet refused before coin read', failure.indexOf('TOO_MANY_COINS') === 0 && commands.length === 1);
        reset(); balance.coins = '53.0'; H.myFreeCoins(AX.trading.USDT_TOKENID, cb);
        T.ok('safe wallet excludes mempool inputs', successes === 1 && commands[1].indexOf('checkmempool:true') > 0);
        reset(); balance.coins = '120'; H.myRelevantCoins(AX.trading.USDT_TOKENID, cb);
        T.ok('diagnostic read is also guarded', commands.length === 1 && !!failure);
        ['1.5', '-1', '', null, 'NaN', '2147483648'].forEach(function (n) {
            reset(); balance.coins = n; H.myFreeCoins(AX.trading.USDT_TOKENID, cb);
            T.ok('invalid count refuses coin read: ' + n, !!failure && commands.length === 1);
        });
        var coin = { coinid: '0xAB', tokenid: '0x00', amount: '1', state: { '0': '0xAB', '4': '0xCD' } };
        function operation(kind) {
            if (kind === 0) H.claim(coin, '0xAB', '0xCD', 'MxADDR', cb);
            else if (kind === 1) H.refund(coin, 'MxADDR', cb);
            else H.lockFromCoins({ coinids: ['0xAB'], totalSelected: '1', amount: '1', requestAmount: '1', reqToken: 'minima',
                receiverPubkey: '0xAB', ownerEthKey: '0xCD', hashlock: '0xEF', timelockBlock: 1000, otc: 'FALSE', myPubkey: '0xAB', tokenId: '0x00', myAddress: 'MxADDR' }, cb);
        }
        for (var kind = 0; kind < 3; kind++) {
            reset(); operation(kind);
            T.ok('validated operation posts once without rebuilding proofs: ' + kind, successes === 1
                && commands.filter(function (c) { return c.indexOf('txnbasics ') === 0; }).length === 1
                && commands.filter(function (c) { return c.indexOf('txnpost ') === 0 && c.indexOf('auto:true') < 0 && c.indexOf('mine:true') > 0; }).length === 1);
            ['basic', 'mmrproofs', 'scripts', 'validamounts', 'allsignaturesvalid', 'validtransaction'].forEach(function (key) {
                var target = key in valid.valid ? valid.valid : valid, old = target[key]; delete target[key];
                reset(); operation(kind);
                T.ok('missing ' + key + ' prevents posting operation ' + kind, !!failure && !commands.some(function (c) { return c.indexOf('txnpost ') === 0; }));
                target[key] = old;
            });
        }
        var rpcReply = null, eth = AX.ethops.make({ ethCall: function (to, data, done) { done(null, rpcReply); } }, '', '');
        [null, '', '0x', '0x00', '0x' + '0'.repeat(63) + '2'].forEach(function (value) {
            rpcReply = value; eth.canCollect('0x' + '11'.repeat(32), function (e) { T.ok('malformed ETH boolean is an error: ' + value, !!e); });
        });
        rpcReply = '0x' + '0'.repeat(768);
        eth.getContract('0x' + '11'.repeat(32), function (e, c) { T.ok('valid zero-owner tuple means absent', !e && c === null); });
        rpcReply = '0x'; eth.getContract('0x' + '11'.repeat(32), function (e) { T.ok('truncated ETH tuple is an error', !!e); });
        reset(); H.verifyPreimage('0xAB;send amount:1', '0xCD', function (e, ok) { T.ok('invalid preimage cannot inject a node command', !ok && commands.length === 0); });
        var lines = AX.inspect.buildReport({ swap: { myLegIsMinima: true, direction: 'ERC20_TO_MINIMA', status: 'LOCKED', sellToken: 'MxUSD', buyToken: 'USDT' },
            block: 100, secretKnown: false, myMin: null, gc: { withdrawn: false, refunded: false }, events: [] });
        T.ok('no-secret report never promises collection', lines.join('\n').indexOf('claimable now') < 0 && lines.join('\n').indexOf('waiting for the secret') > 0);
        lines = AX.inspect.buildReport({ swap: { myLegIsMinima: false, status: 'STARTED' }, minimaError: 'node timeout', events: [] });
        T.ok('failed scan is unknown rather than not found', lines.join('\n').indexOf('UNKNOWN — node timeout') > 0);

        // A row with no recorded transaction must SAY the leg was never posted — not point at a line it
        // never prints (native parity: atomix 0.1.61; live phantom lock 2026-09-20).
        lines = AX.inspect.buildReport({ swap: { myLegIsMinima: true, status: 'STARTED', sellToken: 'MINIMA', buyToken: 'USDT' },
            block: 2325091, secretKnown: true, myMin: null, gc: null, events: [] });
        var txt = lines.join('\n');
        T.ok('phantom row names the missing broadcast', txt.indexOf('Recorded transactions: NONE') > 0 && txt.indexOf('never posted') > 0);
        T.ok('phantom row states nothing is locked', txt.indexOf('Nothing is locked') > 0);
        T.ok('no dangling pointer to an unprinted transaction', txt.indexOf('check the recorded transaction.') < 0);
        lines = AX.inspect.buildReport({ swap: { myLegIsMinima: true, status: 'LOCKED', sellToken: 'MINIMA', buyToken: 'USDT' },
            block: 2325091, secretKnown: true, myMin: null, gc: null,
            events: [{ note: '0x00004FB40585D5D6DAC724C22DE81CB5DDE65D3EEFA888F8B5B0ACDE8F3FBD97' }] });
        T.ok('recorded transactions are counted', lines.join('\n').indexOf('Recorded transactions: 1 (listed above).') > 0);
    } finally { M.cmdR = saved; M.cmd = deleted; }
})();
