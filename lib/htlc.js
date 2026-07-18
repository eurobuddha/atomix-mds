/**
 * htlc — the Minima-leg HTLC covenant constants + one-time setup + state helpers. Byte-identical to native
 * MinimaHtlc.java (a single changed script byte would change the address and break interop). Attaches to AX.htlc.
 * Requires AX.mds. The spends themselves (lock/claim/refund) are built in the engine (Phase 3/4).
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    var M = AX.mds;

    // VERBATIM from native MinimaHtlc.HTLC_SCRIPT — do not reformat.
    var HTLC_SCRIPT =
        'LET version=1.2 LET owner=PREVSTATE(0) LET requestamount=PREVSTATE(1) LET requesttoken=PREVSTATE(2) ' +
        'LET timelock=PREVSTATE(3) LET counterparty=PREVSTATE(4) LET hash=PREVSTATE(5) LET ownerethkey=PREVSTATE(6) ' +
        'IF SIGNEDBY(owner) AND (@BLOCK GT timelock) THEN RETURN TRUE ENDIF LET secret=STATE(100) ' +
        'ASSERT SIGNEDBY(counterparty) AND (SHA2(secret) EQ hash) ASSERT STATE(101) EQ hash ' +
        'ASSERT STATE(102) EQ STRING(owner) ASSERT STATE(103) EQ STRING(counterparty) ' +
        'RETURN VERIFYOUT(@INPUT 0xFFEEDD9999 0.0001 @TOKENID TRUE)';

    var HTLC_ADDRESS = 'MxG080CRJB1D4NHGRYGNF7Q52FK7023UM3FUUPVD1W1WCQZSA8MDQ25982N842G';
    var NOTIFY = '0xFFEEDD9999';
    var NOTIFY_AMOUNT = '0.0001';
    var MINIMA_BLOCK_TIME = 50;                 // seconds
    var TIMELOCK_BLOCKS = 7200 / MINIMA_BLOCK_TIME;   // 144 — first Minima leg
    var CP_BLOCKS = 36;                         // second Minima leg (buy responder)
    var CP_BLOCKS_CHECK = 72;                   // responder half-window guard
    var TIMELOCK_SECS = 7200;                   // first ETH leg
    var CP_SECS = 1800;                         // second ETH leg
    var CP_SECS_CHECK = 3600;                   // responder half-window guard

    /** Register the covenant so its address resolves + reads coins, and pick/persist the swap identity key.
     *  setup(cb(err, {miniaddress, address, publickey})). */
    function setup(cb) {
        M.cmdR('newscript trackall:false script:"' + HTLC_SCRIPT + '"', function (err) {
            if (err) return cb(err);
            M.cmdR('getaddress', function (err2, a) {
                if (err2) return cb(err2);
                if (!a || !a.miniaddress) return cb(new Error('getaddress returned no address (node pending/locked?)'));
                cb(null, { miniaddress: a.miniaddress, address: a.address, publickey: a.publickey });
            });
        });
    }

    /** All 64 node default pubkeys (normalised UPPER, no 0x) for owner/refund matching. loadKeys(cb(err, [pk])). */
    function loadKeys(cb) {
        M.cmdR('keys action:list', function (err, r) {
            if (err) return cb(err);
            var keys = (r && r.keys) || r || [];
            var out = [];
            for (var i = 0; i < keys.length; i++) out.push(normKey(keys[i].publickey || keys[i]));
            cb(null, out);
        });
    }

    /** Node stores state hex UPPER-CASE and matches `state:` case-sensitively — normalise every filter/compare. */
    function normKey(v) { return String(v).replace(/^0x/i, '').toUpperCase(); }

    /** Read a coin state value by port, handling both {"port":val} simplestate and [{port,data}] shapes. */
    function stateAt(coin, port) {
        var st = coin && coin.state;
        if (!st) return null;
        if (Array.isArray(st)) {
            for (var i = 0; i < st.length; i++) if (Number(st[i].port) === Number(port)) return st[i].data;
            return null;
        }
        var v = st[String(port)];
        return (v == null || v === '') ? null : v;
    }

    AX.htlc = {
        SCRIPT: HTLC_SCRIPT, ADDRESS: HTLC_ADDRESS, NOTIFY: NOTIFY, NOTIFY_AMOUNT: NOTIFY_AMOUNT,
        MINIMA_BLOCK_TIME: MINIMA_BLOCK_TIME, TIMELOCK_BLOCKS: TIMELOCK_BLOCKS, CP_BLOCKS: CP_BLOCKS,
        CP_BLOCKS_CHECK: CP_BLOCKS_CHECK, TIMELOCK_SECS: TIMELOCK_SECS, CP_SECS: CP_SECS, CP_SECS_CHECK: CP_SECS_CHECK,
        setup: setup, loadKeys: loadKeys, normKey: normKey, stateAt: stateAt
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
