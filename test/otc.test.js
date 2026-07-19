/* otc — LP verify (fund gate), offer codec, and the negotiation state machine (propose→counter→accept→execute)
   with authentication + consent guards, over a small in-memory MDS.sql. */
(function () {
    var OTC = AX.otc, EO = AX.ethops, D = AX.dec, TR = AX.trading, H = AX.hex;

    // ---- offer codec (two-sided + legacy single-sided) ----
    var oj = OTC.offerToJson({ sellSize: 10, buySize: 5, enable: true, minimaPublicKey: '0xM', ethAddress: '0xE', commsPublicId: '0xC', ts: 7 });
    var back = OTC.offerFromJson(oj);
    T.eq('offer roundtrip sizes', [back.sellSize, back.buySize, back.enable], [10, 5, true]);
    var legacy = OTC.offerFromJson({ en: true, side: 'BUY', size: 12, mpk: '0xM', eth: '0xE', cid: '0xC', ts: 1 });
    T.eq('legacy single-sided → buySize', [legacy.buySize, legacy.sellSize], [12, 0]);

    // ---- otcVerify (the LP fund gate): exact match required ----
    OTC.configure({ identity: { publicId: function () { return '0x' + 'aa'.repeat(64); }, signSk: new Uint8Array(64), signPk: new Uint8Array(32) },
        myMinimaPk: '0xMYPK', ethAddr: '0xLPETH', notify: function () {}, onDealsChanged: function () {} });
    // instigator BUYS mxUSDT, I'm the LP selling: deal amount 50 @ 1.0 → wantMinima 50, wantUsdt 50.
    var dealSell = { side: OTC.SELL, amount: '50', price: '1.0', peerMinimaPk: '0xPEERMPK', peerEthAddr: '0xPEERETH' };
    function buyC(reqMinima, amtUsdt, receiver, token, mpk) {
        return { requestAmount: D.parseUnits(String(reqMinima), 18), amount: D.parseUnits(String(amtUsdt), 6),
            receiver: receiver || '0xLPETH', tokenContract: token || EO.NET.usdt, minimaPublicKey: mpk || '0xPEERMPK' };
    }
    T.eq('otcVerifyBuy exact match', OTC.otcVerifyBuy(buyC(50, 50), dealSell), true);
    T.eq('otcVerifyBuy wrong amount', OTC.otcVerifyBuy(buyC(50, 49), dealSell), false);
    T.eq('otcVerifyBuy USDT not to me', OTC.otcVerifyBuy(buyC(50, 50, '0xSOMEONE'), dealSell), false);
    T.eq('otcVerifyBuy wrong token', OTC.otcVerifyBuy(buyC(50, 50, '0xLPETH', '0x00000000000000000000000000000000000000ff'), dealSell), false);
    T.eq('otcVerifyBuy wrong peer', OTC.otcVerifyBuy(buyC(50, 50, '0xLPETH', EO.NET.usdt, '0xWRONG'), dealSell), false);
    // instigator SELLS mxUSDT, I'm the LP buying: coin locked to me, state[6]=agreed eth, state[1]=USDT I pay.
    var dealBuy = { side: OTC.BUY, amount: '50', price: '1.0', peerEthAddr: '0xPEERETH' };
    function sellCoin(recvMinima, giveUsdt, recv4, eth6, token) {
        return { tokenamount: String(recvMinima), tokenid: TR.USDT_TOKENID, state: { '1': String(giveUsdt), '4': recv4 || '0xMYPK', '6': eth6 || '0xPEERETH' } };
    }
    T.eq('otcVerifySell exact match', OTC.otcVerifySell(sellCoin(50, 50), dealBuy, EO.NET.usdt), true);
    T.eq('otcVerifySell wrong pay-eth', OTC.otcVerifySell(sellCoin(50, 50, '0xMYPK', '0xOTHER'), dealBuy, EO.NET.usdt), false);
    T.eq('otcVerifySell wrong amount', OTC.otcVerifySell(sellCoin(49, 50), dealBuy, EO.NET.usdt), false);

    // ================= state machine over an in-memory MDS.sql =================
    var saved = globalThis.MDS;
    try {
        var deals = {}, msgs = {};
        var DCOL = ['REF', 'ROLE', 'PEERCID', 'PEERMPK', 'PEERETH', 'SIDE', 'AMOUNT', 'PRICE', 'STATUS', 'WHOSETURN', 'HASH', 'CURRENCY', 'CREATED', 'UPDATED'];
        var MCOL = ['RANDOMID', 'REF', 'TYPE', 'SENDER', 'SIDE', 'AMOUNT', 'PRICE', 'HASH', 'DATE'];
        function splitVals(s) {
            var out = [], i = 0, n = s.length;
            while (i < n) { while (i < n && (s[i] === ' ' || s[i] === ',')) i++; if (i >= n) break;
                if (s[i] === "'") { i++; var v = ''; while (i < n) { if (s[i] === "'" && s[i + 1] === "'") { v += "'"; i += 2; } else if (s[i] === "'") { i++; break; } else { v += s[i]; i++; } } out.push(v); }
                else { var w = ''; while (i < n && s[i] !== ',' && s[i] !== ')') { w += s[i]; i++; } out.push(w.trim()); } }
            return out;
        }
        function valsOf(q) { var m = /VALUES\s*\((.*)\)\s*$/s.exec(q); return m ? splitVals(m[1]) : []; }
        var exec = {};   // otc_exec claim table (ref → {owner, ts})
        globalThis.MDS = {
            cmd: function (c, cb) { if (c.indexOf('random') === 0) return cb({ status: true, response: { random: '0x' + Math.floor(rndCtr()).toString(16) } }); cb({ status: true, response: [] }); },
            sql: function (q, cb) {
                if (/^\s*CREATE/i.test(q)) return cb({ status: true });
                if (/INSERT INTO `otc_exec`/.test(q)) { var mm = /SELECT '([^']*)','([^']*)',(\d+)\s+WHERE NOT EXISTS/.exec(q); if (mm && !(mm[1] in exec)) exec[mm[1]] = { owner: mm[2], ts: Number(mm[3]) }; return cb({ status: true }); }
                if (/UPDATE `otc_exec` SET/.test(q)) {
                    var um = /SET `owner`='([^']*)', `ts`=(\d+) WHERE `ref`='([^']*)' AND \(`owner`='[^']*' OR `ts` IS NULL OR `ts` < (\d+)\)/.exec(q);
                    if (um) { var er = exec[um[3]]; if (er && (er.owner === um[1] || er.ts == null || er.ts < Number(um[4]))) { er.owner = um[1]; er.ts = Number(um[2]); } }
                    return cb({ status: true });
                }
                if (/SELECT `owner` FROM `otc_exec`/.test(q)) { var rf = /ref`='([^']*)'/.exec(q); return cb({ status: true, rows: (rf && exec[rf[1]] != null) ? [{ OWNER: exec[rf[1]].owner }] : [] }); }
                if (/MERGE INTO `otc_deals`/.test(q)) { var v = valsOf(q), row = {}; DCOL.forEach(function (c, i) { row[c] = v[i]; }); deals[row.REF] = row; return cb({ status: true }); }
                if (/INSERT INTO `otc_msgs`/.test(q)) { var v2 = valsOf(q), r2 = {}; MCOL.forEach(function (c, i) { r2[c] = v2[i]; }); msgs[r2.RANDOMID] = r2; return cb({ status: true }); }
                if (/SELECT 1 AS X FROM `otc_msgs`/.test(q)) { var rid = /randomid`='([^']*)'/.exec(q); return cb({ status: true, rows: (rid && msgs[rid[1]]) ? [{ X: 1 }] : [] }); }
                if (/SELECT \* FROM `otc_deals` WHERE `ref`/.test(q)) { var rf = /ref`='([^']*)'/.exec(q); return cb({ status: true, rows: (rf && deals[rf[1]]) ? [deals[rf[1]]] : [] }); }
                if (/replace\(lower/.test(q)) { var hh = /='([^']*)'/.exec(q); var f = null; for (var k in deals) { if (String(deals[k].HASH || '').toLowerCase().replace('0x', '') === hh[1]) f = deals[k]; } return cb({ status: true, rows: f ? [f] : [] }); }
                if (/SELECT \* FROM `otc_deals`/.test(q)) { return cb({ status: true, rows: Object.keys(deals).map(function (k) { return deals[k]; }) }); }
                if (/SELECT \* FROM `otc_msgs`/.test(q)) { return cb({ status: true, rows: [] }); }
                if (/DELETE/.test(q)) return cb({ status: true });
                cb({ status: true, rows: [] });
            }
        };

        var LP = '0x' + 'aa'.repeat(64), PEER = '0x' + 'bb'.repeat(64);
        // I am the LP (identity=LP). setMyOffer live on both sides.
        OTC.setMyOffer(true, 100, 100);

        // inbound PROPOSE from PEER (instigator) → creates an LP deal, my turn.
        var proposeMsg = { type: 'PROPOSE', ref: 'REF1', randomid: 'R1', from: PEER, to: LP, date: 1, side: OTC.SELL, amount: '50', price: '1.0', minimaPk: '0xPEERM', ethAddr: '0xPEERE' };
        OTC.route({ valid: true, fromPublicId: PEER, plaintext: H.utf8(JSON.stringify(proposeMsg)) }, function (e, handled) {
            T.eq('PROPOSE handled → deal created', handled, true);
        });
        OTC.getDeal('REF1', function (e, d) {
            T.ok('LP deal PROPOSED my-turn', d && d.role === OTC.ROLE_LP && d.status === OTC.ST_PROPOSED && d.whoseTurn === OTC.TURN_ME);
        });

        // AUTHENTICATION: a COUNTER from a DIFFERENT sender (not the peer) is ignored.
        OTC.route({ valid: true, fromPublicId: '0x' + 'cc'.repeat(64), plaintext: H.utf8(JSON.stringify({ type: 'COUNTER', ref: 'REF1', randomid: 'RX', from: '0x' + 'cc'.repeat(64), to: LP, side: OTC.SELL, amount: '999', price: '9' })) }, function () {});
        OTC.getDeal('REF1', function (e, d) { T.eq('foreign COUNTER ignored (amount unchanged)', d.amount, '50'); });

        // CONSENT: an ACCEPT from the peer when it's MY turn (not peer's) is ignored.
        OTC.route({ valid: true, fromPublicId: PEER, plaintext: H.utf8(JSON.stringify({ type: 'ACCEPT', ref: 'REF1', randomid: 'R2', from: PEER, to: LP })) }, function () {});
        OTC.getDeal('REF1', function (e, d) { T.eq('ACCEPT on my-turn ignored (still PROPOSED)', d.status, OTC.ST_PROPOSED); });

        // I (LP) counter → COUNTERED, peer's turn.
        OTC.getDeal('REF1', function (e, d) { OTC.counter(d, '40', '1.01', function (err) { T.ok('LP counter sent', !err); }); });
        OTC.getDeal('REF1', function (e, d) { T.ok('after counter: COUNTERED peer-turn', d.status === OTC.ST_COUNTERED && d.whoseTurn === OTC.TURN_PEER && d.amount === '40'); });

        // peer ACCEPTs my counter → AGREED (I'm the LP → my turn stays PEER; instigator would execute).
        OTC.route({ valid: true, fromPublicId: PEER, plaintext: H.utf8(JSON.stringify({ type: 'ACCEPT', ref: 'REF1', randomid: 'R3', from: PEER, to: LP })) }, function () {});
        OTC.getDeal('REF1', function (e, d) { T.eq('peer ACCEPT → AGREED', d.status, OTC.ST_AGREED); });

        // peer EXECUTEs (locked leg 1) with a hash → EXECUTING.
        OTC.route({ valid: true, fromPublicId: PEER, plaintext: H.utf8(JSON.stringify({ type: 'EXECUTE', ref: 'REF1', randomid: 'R4', from: PEER, to: LP, hash: '0x' + '22'.repeat(32) })) }, function () {});
        OTC.getDeal('REF1', function (e, d) { T.ok('EXECUTE → EXECUTING with hash', d.status === OTC.ST_EXECUTING && d.hash); });

        // otcLpDeal links the on-chain hash back to the agreed deal (active currency).
        OTC.otcLpDeal('0x' + '22'.repeat(32), function (d) { T.ok('otcLpDeal finds the EXECUTING LP deal', d && d.ref === 'REF1'); });

        // SINGLE-ACTOR: two instances (distinct tokens) racing claimExecute on one ref → exactly one wins.
        OTC._setExecToken('instA');
        OTC.claimExecute('REFX', function (won) { T.eq('instance A wins the claim', won, true); });
        OTC._setExecToken('instB');
        OTC.claimExecute('REFX', function (won) { T.eq('instance B loses (A owns it)', won, false); });
        OTC._setExecToken('instA');
        OTC.claimExecute('REFX', function (won) { T.eq('A re-wins on retry (idempotent)', won, true); });

        // TTL-STEAL: a DEAD claimant's row (stale ts — its instance restarted and lost the token) is taken over,
        // so the deal can still execute; a FRESH row is never stolen (the live winner keeps it).
        exec['REFY'] = { owner: 'deadTok', ts: Date.now() - 11 * 60 * 1000 };
        OTC._setExecToken('instB');
        OTC.claimExecute('REFY', function (won) { T.eq('stale (dead-instance) claim stolen', won, true); });
        exec['REFZ'] = { owner: 'liveTok', ts: Date.now() };
        OTC.claimExecute('REFZ', function (won) { T.eq('fresh claim NOT stolen', won, false); });
    } finally { globalThis.MDS = saved; }

    var _rc = 0x1000; function rndCtr() { _rc += 1; return _rc; }
})();
