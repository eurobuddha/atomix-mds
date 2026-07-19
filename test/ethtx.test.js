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

            // 5) F5 gas floor: gasPrice floored at 2× base fee when the raw price is below it.
            ETX.resetAll(); gps.length = 0;
            var r5 = fakeRpc(function () { return 0; }, { gp: 1000000000n, baseFee: 5000000000n }); // gp*1.2=1.2gwei < 2×base=10gwei
            ETX.send(r5, PRIV, '0xADDR5', 1, '0xTo', '0xdata', 0n, 500000n, function () {});
            T.eq('gas floored at 2× base fee', String(gps[0]), '10000000000');
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

