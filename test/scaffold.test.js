/* Scaffolding: kv store round-trip (mock MDS.sql) + HTLC constants + prng service bootstrap. */
(function () {
    var M = AX.mds, HT = AX.htlc, TR = AX.trading, ID = AX.identity;

    // ---- HTLC constants byte-match native (a changed byte breaks the shared address) ----
    T.eq('HTLC address', HT.ADDRESS, 'MxG080CRJB1D4NHGRYGNF7Q52FK7023UM3FUUPVD1W1WCQZSA8MDQ25982N842G');
    T.eq('notify addr', HT.NOTIFY, '0xFFEEDD9999');
    T.eq('notify amount', HT.NOTIFY_AMOUNT, '0.0001');
    T.eq('first minima timelock blocks', HT.TIMELOCK_BLOCKS, 144);
    T.eq('cp blocks', HT.CP_BLOCKS, 36);
    T.ok('script starts with the covenant preamble', HT.SCRIPT.indexOf('LET version=1.2 LET owner=PREVSTATE(0)') === 0);
    T.ok('script ends with the notify VERIFYOUT', HT.SCRIPT.indexOf('RETURN VERIFYOUT(@INPUT 0xFFEEDD9999 0.0001 @TOKENID TRUE)') > 0);

    // ---- stateAt handles both simplestate shapes ----
    T.eq('stateAt object', HT.stateAt({ state: { '5': '0xABC' } }, 5), '0xABC');
    T.eq('stateAt array', HT.stateAt({ state: [{ port: 5, data: '0xABC' }] }, 5), '0xABC');
    T.eq('stateAt missing', HT.stateAt({ state: {} }, 5), null);
    T.eq('normKey upper no-0x', HT.normKey('0xdeadBEEF'), 'DEADBEEF');

    // ---- kv store round-trip against a mock in-memory MDS.sql (H2 UPPERCASE columns, synchronous callbacks) ----
    (function () {
        var store = {};
        globalThis.MDS = {
            sql: function (q, cb) {
                var m;
                if (/CREATE TABLE/i.test(q)) return cb({ status: true });
                if ((m = q.match(/^MERGE INTO ax_kv \(k, v\) KEY\(k\) VALUES \('([\s\S]*)', '([\s\S]*)'\)$/))) { store[m[1].split("''").join("'")] = m[2].split("''").join("'"); return cb({ status: true }); }
                if ((m = q.match(/^SELECT v FROM ax_kv WHERE k='([\s\S]*)'$/))) {
                    var k = m[1].split("''").join("'");
                    return cb(store[k] !== undefined ? { status: true, rows: [{ V: store[k] }] } : { status: true, rows: [] });
                }
                if ((m = q.match(/^DELETE FROM ax_kv WHERE k='([\s\S]*)'$/))) { delete store[m[1].split("''").join("'")]; return cb({ status: true }); }
                return cb({ status: false });
            }
        };
        // AX.flow.waterfall over the callback-based kv API (all mock callbacks fire synchronously).
        AX.flow.waterfall([
            function (next) { M.kvInit(function () { next(); }); },
            function (next) { M.kvSet('trading_currency', 'minima', function () { next(); }); },
            function (next) { M.kvGet('trading_currency', 'mxusdt', function (v) { T.eq('kv get after set', v, 'minima'); next(); }); },
            function (next) { M.kvGet('missing', 'DEF', function (v) { T.eq('kv default', v, 'DEF'); next(); }); },
            function (next) { M.kvSet('quote', "O'Brien's", function () { next(); }); },  // sql-injection-safe escaping
            function (next) { M.kvGet('quote', null, function (v) { T.eq('kv escapes single quotes', v, "O'Brien's"); next(); }); }
        ]);
    })();

    T.eq('SQL esc doubles quotes', M.esc("a'b"), "a''b");
})();
