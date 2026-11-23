/* ethtx — per-address nonce serializer: allocation branches, self-heal, commit-after-broadcast, serialized queue. */
(function () {
    var ETX = AX.ethtx;

    // A controllable fake RPC. pending is a function so a test can advance it; sends can be forced to fail.
    function fakeRpc(getPending, opts) {
        opts = opts || {};
        return {
            sent: [],
            getTransactionCount: function (addr, cb) { cb(null, BigInt(getPending())); },
            gasPrice: function (cb) { cb(null, opts.gp == null ? 1000000000n : opts.gp); },
            baseFeePerGasOrZero: function (cb) { cb(null, opts.baseFee == null ? 0n : opts.baseFee); },
            sendRawTransaction: function (raw, cb) {
                if (opts.failNext) { opts.failNext = false; return cb(new Error('broadcast dropped')); }
                this.sent.push(raw); cb(null, '0x' + 'ab'.repeat(31) + (this.sent.length < 16 ? '0' : '') + this.sent.length.toString(16));
            }
        };
    }

    // Capture the nonce the signer sees (stub the real signer so no key material is needed).
    var savedSign = AX.eth.signLegacyTx, nonces = [], gps = [];
    AX.eth.signLegacyTx = function (tx) { nonces.push(tx.nonce); gps.push(tx.gasPriceWei); return '0x' + 'cc'; };

    var PRIV = '0x' + '11'.repeat(32);
    function run() {
        try {
            // 1) cold → alloc = pending; in-sync back-to-back → +1 (pending lags a just-broadcast tx).
            ETX.resetAll(); nonces.length = 0;
            var r1 = fakeRpc(function () { return 5; });
            ETX.send(r1, PRIV, '0xADDR1', 1, '0xTo', '0xdata', 0n, 500000n, function () {});
            ETX.send(r1, PRIV, '0xADDR1', 1, '0xTo', '0xdata', 0n, 500000n, function () {});
            T.eq('cold→pending, then serial +1', nonces.slice(), [5, 6]);

            // 2) an external tx advanced the account → adopt the higher pending.
            ETX.resetAll(); nonces.length = 0;
            var p = 5; var r2 = fakeRpc(function () { return p; });
            ETX.send(r2, PRIV, '0xADDR2', 1, '0xTo', '0xdata', 0n, 500000n, function () {});
            p = 10;
            ETX.send(r2, PRIV, '0xADDR2', 1, '0xTo', '0xdata', 0n, 500000n, function () {});
            T.eq('external advance adopts pending', nonces.slice(), [5, 10]);

            // 3) self-heal: pending stuck behind us past STALE_MS → re-allocate pending (drop the dead nonce).
            ETX.resetAll(); nonces.length = 0;
            var t = 1000; ETX._setNow(function () { return t; });
            var r3 = fakeRpc(function () { return 5; });
            ETX.send(r3, PRIV, '0xADDR3', 1, '0xTo', '0xdata', 0n, 500000n, function () {}); // alloc 5, next 6
            t += ETX.STALE_MS + 1;                                                            // sit stuck too long
            ETX.send(r3, PRIV, '0xADDR3', 1, '0xTo', '0xdata', 0n, 500000n, function () {}); // HEAL → alloc 5 again
            T.eq('stale heal re-allocates pending', nonces.slice(), [5, 5]);
            ETX._setNow(function () { return Date.now(); });

            // 4) commit only after a successful broadcast: a failed send must NOT advance the counter.
            ETX.resetAll(); nonces.length = 0;
            var r4 = fakeRpc(function () { return 7; }, { failNext: true });
            var errs = [];
            ETX.send(r4, PRIV, '0xADDR4', 1, '0xTo', '0xdata', 0n, 500000n, function (e) { errs.push(!!e); });
            ETX.send(r4, PRIV, '0xADDR4', 1, '0xTo', '0xdata', 0n, 500000n, function (e) { errs.push(!!e); });
            T.eq('failed send errors, next succeeds', errs, [true, false]);
            T.eq('dropped nonce NOT advanced (reused)', nonces.slice(), [7, 7]);

            // 5) F5 gas floor (0.1.40): gasPrice floored at base fee +12.5% + a 0.2 gwei tip (was 2× base).
            ETX.resetAll(); gps.length = 0;
            var r5 = fakeRpc(function () { return 0; }, { gp: 1000000000n, baseFee: 5000000000n }); // gp*1.125=1.125gwei < floor 5.825gwei
            ETX.send(r5, PRIV, '0xADDR5', 1, '0xTo', '0xdata', 0n, 500000n, function () {});
            T.eq('gas floored at base+12.5%+tip', String(gps[0]), '5825000000');

            // 5b) 0.1.67 hard ceiling (8000 gwei) after headroom + floor, before signing: a hostile/broken RPC's absurd quote
            //     is refused (nothing signed, nonce untouched); a real spike and the desktop's own highest price still pass.
            function feeCase(gp, baseFee) {
                ETX.resetAll(); gps.length = 0; nonces.length = 0;
                var rr = fakeRpc(function () { return 3; }, { gp: gp, baseFee: baseFee }), out = {};
                ETX.send(rr, PRIV, '0xADDRFEE', 1, '0xTo', '0xdata', 0n, 120000n, function (e, h) { out.e = e; out.h = h; });
                out.signed = gps.length; out.sent = rr.sent.length; return out;
            }
            var GWEI = 1000000000n;
            var hostile = feeCase(100000n * GWEI, 0n);
            T.ok('ceiling: a 100000 gwei quote is refused loudly', hostile.e && hostile.e.feeRefused === true && /ETH_FEE_REFUSED/.test(hostile.e.message));
            T.eq('ceiling: nothing signed or sent', [hostile.signed, hostile.sent], [0, 0]);
            var hostileBase = feeCase(1n * GWEI, 9000n * GWEI);
            T.ok('ceiling: a hostile base fee cannot lift the floor past it', hostileBase.e && hostileBase.e.feeRefused === true && hostileBase.signed === 0);
            var spike = feeCase(1500n * GWEI, 1200n * GWEI);
            T.ok('ceiling: a 1500 gwei spike still signs (claims/refunds near a deadline are not blocked)', !spike.e && spike.signed === 1);
            var desk = feeCase((5000n * GWEI * 170n * 10n) / (100n * 12n), 2500n * GWEI);   // the desktop proxy's High tier at its anchor cap
            T.ok('ceiling: the desktop host highest tier price (7968.749999999 gwei) still signs', !desk.e && desk.signed === 1 && String(gps[0]) === '7968749999999');
            ETX.resetAll(); nonces.length = 0;
            var q = { gp: 100000n * GWEI }, rq = fakeRpc(function () { return 3; }, q);
            ETX.send(rq, PRIV, '0xADDRFEE2', 1, '0xTo', '0xdata', 0n, 120000n, function () {});   // refused
            q.gp = 1n * GWEI;
            ETX.send(rq, PRIV, '0xADDRFEE2', 1, '0xTo', '0xdata', 0n, 120000n, function () {});
            T.eq('ceiling: a refusal consumes no nonce (the next send signs nonce 3)', nonces.slice(), [3]);

            // 5c) 0.1.70: an over-ceiling quote is re-quoted on two OTHER endpoints of the (unchanged) fallback list and the
            //     median of the three is used — one hostile endpoint can neither make us sign an absurd fee nor block a send.
            var FB = AX.ethrpc.FALLBACKS;
            function quoteCase(primary, answers) {   // answers: endpoint → gwei quote | null (down); baseFee 0 everywhere
                ETX.resetAll(); gps.length = 0; nonces.length = 0;
                var rr = fakeRpc(function () { return 4; }, { gp: 100000n * GWEI }), out = { asked: [] };
                rr.url = primary;
                rr.callOn = function (ep, method, params, cb) {
                    if (method === 'eth_gasPrice') out.asked.push(ep);
                    var g = answers[ep];
                    if (g == null) return cb(new Error(ep + ' down'));
                    if (method === 'eth_gasPrice') return cb(null, '0x' + (BigInt(g) * GWEI).toString(16));
                    cb(null, { baseFeePerGas: '0x0' });
                };
                ETX.send(rr, PRIV, '0xADDRQ', 1, '0xTo', '0xdata', 0n, 120000n, function (e, h) { out.e = e; out.h = h; });
                out.signed = gps.slice(); out.sent = rr.sent.length; return out;
            }
            var honest = {}; honest[FB[1]] = 20; honest[FB[2]] = 30;
            var q1 = quoteCase(FB[0], honest);
            T.eq('requote: one hostile endpoint → signs at the median of three (30 gwei +12.5%)', [!!q1.e, q1.signed.map(String), q1.sent], [false, ['33750000000'], 1]);
            T.eq('requote: asks two OTHER fallback endpoints in list order, never the one that quoted', q1.asked, [FB[1], FB[2]]);
            var gap = {}; gap[FB[2]] = 20; gap[FB[4]] = 25;
            var q2 = quoteCase(FB[0], gap);
            T.eq('requote: a down endpoint is skipped for the next one', [!!q2.e, q2.asked.length >= 3, q2.signed.map(String)], [false, true, ['28125000000']]);
            var two = {}; two[FB[1]] = 90000; two[FB[2]] = 20;
            var q3 = quoteCase(FB[0], two);
            T.ok('requote: two of three over the ceiling → still refused, nothing signed', q3.e && q3.e.feeRefused === true && q3.signed.length === 0 && /median/.test(q3.e.message));
            var lone = {}; lone[FB[3]] = 20;
            var q4 = quoteCase(FB[0], lone);
            T.ok('requote: fewer than two other answers → refused (no median of one)', q4.e && q4.e.feeRefused === true && q4.signed.length === 0);
            T.eq('requote: the fallback list itself is untouched (four copies stay in lockstep)', FB.length, 9);
        } finally { AX.eth.signLegacyTx = savedSign; }
    }

    // 6) serialized queue under ASYNC rpc: the 2nd send must not read pending until the 1st has committed.
    function runAsync(done) {
        var savedSign2 = AX.eth.signLegacyTx, nn = [];
        AX.eth.signLegacyTx = function (tx) { nn.push(tx.nonce); return '0x' + 'cc'; };
        ETX.resetAll();
        var released = [];
        var order = [];
        var asyncRpc = {
            sent: 0,
            getTransactionCount: function (addr, cb) { order.push('read'); released.push(function () { cb(null, 5n); }); },
            gasPrice: function (cb) { cb(null, 1000000000n); },
            baseFeePerGasOrZero: function (cb) { cb(null, 0n); },
            sendRawTransaction: function (raw, cb) { order.push('send'); cb(null, '0x' + 'ee'.repeat(32)); }
        };
        ETX.send(asyncRpc, '0x' + '11'.repeat(32), '0xASYNC', 1, '0xTo', '0xdata', 0n, 500000n, function () {});
        ETX.send(asyncRpc, '0x' + '11'.repeat(32), '0xASYNC', 1, '0xTo', '0xdata', 0n, 500000n, function () {});
        // Only ONE pending read should be outstanding (2nd send queued behind the busy flag).
        T.eq('queue: only 1 read before release', released.length, 1);
        released[0]();                      // finish send A → pump runs send B → its read is queued
        T.eq('queue: B reads only AFTER A broadcast', order.join(','), 'read,send,read');
        released[1]();                      // finish send B
        T.eq('queue: full order read/send/read/send', order.join(','), 'read,send,read,send');
        T.eq('queue: consecutive nonces, never a collision', nn.slice(), [5, 6]);
        AX.eth.signLegacyTx = savedSign2;
        done && done();
    }

    // 7) cross-instance broadcast lock: lost → BUSY error + no broadcast; won → broadcasts + releases.
    function runLock() {
        var savedSign2 = AX.eth.signLegacyTx;
        AX.eth.signLegacyTx = function () { return '0x' + 'cc'; };
        ETX.resetAll();
        var rLost = fakeRpc(function () { return 3; }), e1 = null;
        ETX.useLock(function (cb) { cb(false); }, function (cb) { cb(); });
        ETX.send(rLost, PRIV, '0xLK1', 1, '0xTo', '0xdata', 0n, 500000n, function (e) { e1 = e; });
        T.ok('lock lost → BUSY error', !!(e1 && e1.busy));
        T.eq('lock lost → no broadcast', rLost.sent.length, 0);
        var rWon = fakeRpc(function () { return 3; }), released = 0, ok = null;
        ETX.useLock(function (cb) { cb(true); }, function (cb) { released++; cb(); });
        ETX.send(rWon, PRIV, '0xLK2', 1, '0xTo', '0xdata', 0n, 500000n, function (e, h) { ok = { e: e, h: h }; });
        T.ok('lock won → broadcast ok', !!(ok && !ok.e && ok.h));
        T.eq('lock won → lock released', released, 1);
        T.eq('lock won → broadcast happened', rWon.sent.length, 1);
        ETX.useLock(null, null);   // restore no-lock for any later tests
        AX.eth.signLegacyTx = savedSign2;
    }

    run();
    runAsync();
    runLock();
})();

