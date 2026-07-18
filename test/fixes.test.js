/* Regression tests for the Phase-1 review fixes (O1 flow guards, M1 strict hex, M2 openValid, M6 canonical id). */
(function () {
    var F = AX.flow, H = AX.hex, ID = AX.identity;

    // ---- O1: flow.once + waterfall can't double-fire done / double-run a step ----
    (function () {
        var doneCount = 0;
        F.waterfall([
            function (next) { next(null, 1); },
            function (a, next) { next(null, a + 1); next(null, 999); }  // buggy step calls next twice
        ], function (err, v) { doneCount++; T.eq('waterfall final value (first next wins)', v, 2); });
        T.eq('done fired exactly once despite double next', doneCount, 1);

        var d2 = 0;
        F.waterfall([
            function (next) { next(null); throw new Error('after-next throw'); }  // throw AFTER next
        ], function () { d2++; });
        T.eq('throw-after-next does not double-fire done', d2, 1);

        var mapped = null;
        F.map([1, 2, 3], function (x, i, n) { n(null, x * 10); }, function (err, out) { mapped = out; });
        T.eq('map collects in order', mapped, [10, 20, 30]);
    })();

    // ---- M1: strict hex — reject odd-length + non-hex (native parity: those are invalid) ----
    (function () {
        var threw = false; try { H.from('abc'); } catch (e) { threw = true; }
        T.ok('odd-length hex throws', threw);
        threw = false; try { H.from('zzzz'); } catch (e) { threw = true; }
        T.ok('non-hex throws', threw);
        T.eq('valid hex ok', H.to(H.from('0xDEAD')), 'dead');
        T.ok('isValidPublicId rejects 128-char garbage', ID.isValidPublicId('zz' + Array(128).join('z')) === false);
        // a real 130-char id is accepted
        var id = ID.fromSeed('x', 'usdtswap');
        T.ok('isValidPublicId accepts a real id', ID.isValidPublicId(id.publicId()));
    })();

    // ---- M2/M6: openValid returns null on invalid; fromPublicId is canonical lowercase 0x ----
    (function () {
        var sender = ID.fromSeed('sender-x', 'usdtswap');
        var recip = ID.fromSeed('0xABCD0000000000000000000000000000000000000000000000000000000000EF', 'usdtswap');
        var blob = ID.seal(sender, recip.publicId(), H.utf8('{"a":1}'));
        T.ok('openValid returns the message for the right recipient', !!ID.openValid(recip, blob));
        var other = ID.fromSeed('0xABCD0000000000000000000000000000000000000000000000000000000000AA', 'usdtswap');
        T.ok('openValid returns null for the wrong recipient', ID.openValid(other, blob) === null);
        var o = ID.open(recip, blob);
        T.eq('fromPublicId is canonical lowercase', o.fromPublicId, '0x' + H.to(H.from(sender.publicId())));
        // tamper the sealed bytes → openValid must reject (sealOpen fails or sig invalid)
        var bad = blob.slice(0, blob.length - 2) + (blob.slice(-2) === '00' ? '01' : '00');
        T.ok('tampered blob → openValid null', ID.openValid(recip, bad) === null);
    })();

    // ---- seal rejects a bad recipient id ----
    (function () {
        var me = ID.fromSeed('m', 'usdtswap'), threw = false;
        try { ID.seal(me, '0xshort', H.utf8('x')); } catch (e) { threw = true; }
        T.ok('seal rejects bad recipient id', threw);
    })();
})();
