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

    // ---- Minima-leg operations (port of MinimaHtlc.java) ----

    /** Fresh 32-byte secret + its SHA2 (SHA256) hashlock, the same way the bridge does. cb(err, {secret, hash}). */
    function generateSecret(cb) {
        M.cmdR('random type:sha2', function (err, resp) {
            if (err) return cb(err);
            if (!resp) return cb(new Error('random returned nothing'));
            var secret = resp.random || '', hash = resp.hashed || '';
            if (!secret || !hash) return cb(new Error('random missing secret/hash'));
            cb(null, { secret: secret, hash: hash });
        });
    }

    /** Current chain tip block number. cb(err, block:int). */
    function currentBlock(cb) {
        M.cmdR('block', function (err, resp) { cb(err, err ? 0 : (resp ? Number(resp.block || 0) : 0)); });
    }

    /** Quantize a Minima-leg (mxUSDT) lock amount DOWN to the 6dp trade grain — the 1:1 grain vs the 6dp ERC20
     *  USDT counter-leg. Last-line guard that a >6dp amount can never reach the node as a sub-grain send. */
    function grain(amt) { try { return AX.dec.grain6(amt); } catch (e) { return amt; } }
    /** Grain only when the locked token is mxUSDT (the 6dp ERC20 pair); native MINIMA (0x00, 44dp) is left as-is. */
    function maybeGrain(amt, tokenId) {
        var usdt = AX.trading && AX.trading.USDT_TOKENID;
        return (usdt && String(tokenId).toLowerCase() === String(usdt).toLowerCase()) ? grain(amt) : amt;
    }

    /** The traded VALUE of a coin: mxUSDT is a coloured token whose `amount` is ~1e-37 underlying — the real value
     *  is `tokenamount`; native 0x00 has no `tokenamount` so `amount` IS the value. ALWAYS read through here. */
    function coinAmount(coin) {
        if (!coin) return '0';
        var ta = coin.tokenamount;
        if (ta != null && ta !== '') return String(ta);
        var a = coin.amount;
        return (a == null || a === '') ? '0' : String(a);
    }

    /**
     * LOCK: send a single coin to the HTLC with the 7 PREVSTATE fields (state 0-7). p = {amount, requestAmount,
     * reqToken, receiverPubkey, ownerEthKey, hashlock, timelockBlock, otc('TRUE'|'FALSE'), myPubkey, tokenId}.
     * Funds from ANY of my 64 default addresses (refund owner pinned via state[0]); grains when tokenId is mxUSDT.
     * cb(err, txpowid). NOTE: like native, a returned txpowid is the mempool id — NOT the eventual on-chain id.
     */
    function lock(p, cb) {
        var state = {
            '0': p.myPubkey, '1': p.requestAmount, '2': '[' + p.reqToken + ']', '3': p.timelockBlock,
            '4': p.receiverPubkey, '5': p.hashlock, '6': p.ownerEthKey, '7': p.otc
        };
        var amount = maybeGrain(p.amount, p.tokenId);
        var send = 'send amount:' + amount + ' mine:true address:' + HTLC_ADDRESS +
            ' state:' + JSON.stringify(state) + ' tokenid:' + p.tokenId;
        M.cmdR(send, function (err, resp) { cb(err, err ? '' : (resp ? (resp.txpowid || '') : '')); });
    }

    // ---- settlement scans (coinnotify-add a shared address FIRST, then a bounded state-filtered read) ----

    function scanState(value, coinageMin, depth, cb) {
        // SETTLEMENT scan: NO tokenid filter — the state: value (a unique hashlock or my pubkey) already scopes the
        // reply, and dropping the token filter lets a claim/refund find an in-flight coin in EITHER currency.
        M.cmd('coinnotify action:add address:' + HTLC_ADDRESS, function () {
            M.cmdR('coins coinage:' + coinageMin + ' simplestate:true state:' + normKey(value) +
                ' address:' + HTLC_ADDRESS + ' depth:' + depth, function (err, resp) {
                cb(err, (!err && Array.isArray(resp)) ? resp : []);
            });
        });
    }
    /** Open HTLC coins for one hashlock (state[5]). */
    function scanByHash(hash, coinageMin, depth, cb) { scanState(hash, coinageMin, depth, cb); }
    /** Open HTLC coins carrying MY key — owner state[0] (coins I locked) or receiver state[4] (locked to me). */
    function scanByKey(myPubkey, coinageMin, depth, cb) { scanState(myPubkey, coinageMin, depth, cb); }

    /** Find the revealed-secret notify coin for ONE hashlock (a claim writes the hash to state[101]). The notify
     *  address is a SHARED global sink, so we coinnotify-add it then filter by state:<hash> (else a busy mainnet
     *  could return a multi-MB reply). cb(err, arr). */
    function scanNotifySecret(hash, depth, cb) {
        M.cmd('coinnotify action:add address:' + NOTIFY, function () {
            M.cmdR('coins simplestate:true depth:' + depth + ' state:' + normKey(hash) + ' address:' + NOTIFY,
                function (err, resp) { cb(err, (!err && Array.isArray(resp)) ? resp : []); });
        });
    }

    AX.htlc = {
        SCRIPT: HTLC_SCRIPT, ADDRESS: HTLC_ADDRESS, NOTIFY: NOTIFY, NOTIFY_AMOUNT: NOTIFY_AMOUNT,
        MINIMA_BLOCK_TIME: MINIMA_BLOCK_TIME, TIMELOCK_BLOCKS: TIMELOCK_BLOCKS, CP_BLOCKS: CP_BLOCKS,
        CP_BLOCKS_CHECK: CP_BLOCKS_CHECK, TIMELOCK_SECS: TIMELOCK_SECS, CP_SECS: CP_SECS, CP_SECS_CHECK: CP_SECS_CHECK,
        setup: setup, loadKeys: loadKeys, normKey: normKey, stateAt: stateAt,
        generateSecret: generateSecret, currentBlock: currentBlock, grain: grain, maybeGrain: maybeGrain,
        coinAmount: coinAmount, lock: lock, scanByHash: scanByHash, scanByKey: scanByKey, scanNotifySecret: scanNotifySecret
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
