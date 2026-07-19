/* maker — build order from config, publish (pegged + manual), tombstone, keep-alive/reprice, currency switch. */
(function () {
    var MK = AX.maker, O = AX.order, B = AX.book, PEG = AX.peg, TR = AX.trading, MDS = AX.mds;

    // in-memory kv (maker persists config/state through AX.mds.kvGet/kvSet)
    var kv = {}, savedGet = MDS.kvGet, savedSet = MDS.kvSet;
    MDS.kvGet = function (k, d, cb) { cb(k in kv ? kv[k] : d); };
    MDS.kvSet = function (k, v, cb) { kv[k] = v; cb && cb(null); };
    // capture published orders
    var savedPub = B.publishFresh, published = [];
    B.publishFresh = function (me, order, cb) { published.push(order); cb(null); };
    var identity = { publicId: function () { return '0x' + 'ab'.repeat(64); } };

    try {
        MK.configure({ identity: identity, myMinimaPk: '0xMYPK', ethAddr: '0xETH', notify: function () {}, onOrder: function () {} });

        // ---- pegged publish: fresh price 1.0, step 1%, size 10, 1 level ----
        PEG._reset(); PEG._setPrice(1.0, 0);
        MK.saveConfig({ pegEnable: true, step: 1, size: 10, bias: 0, levels: 1, min: 1, reprice: 1 }, { bids: [], asks: [] }, function () {});
        published.length = 0;
        MK.publish({ minima: 500, usdt: 500 }, function (err) { T.ok('pegged publish ok', !err); });
        T.eq('published one order', published.length, 1);
        var o1 = published[0];
        T.eq('order identity mpk/eth/cid', [o1.mpk, o1.eth, o1.cid], ['0xMYPK', '0xETH', identity.publicId()]);
        T.eq('order balances stamped', [o1.usdtAvail], [500]);
        T.eq('pegged ladder ask 1.01', o1.pairs.USDT.asks[0].p, 1.01);
        T.eq('pegged ladder bid 0.99', o1.pairs.USDT.bids[0].p, 0.99);
        // commitPeg advanced the reprice baseline
        T.eq('commitPeg stamped lastMid', MK._state().state.lastMid, 1.0);
        T.eq('commitPeg cleared withdrawn', MK._state().state.withdrawn, false);
        // currentOrder is live (not withdrawn)
        T.ok('currentOrder live', MK.currentOrder() && MK.currentOrder().pairs.USDT.asks.length === 1);

        // ---- pegged publish with NO price → auto-tombstone (don't publish stale) ----
        PEG._reset();   // no price
        published.length = 0;
        MK.publish({ minima: 500, usdt: 500 }, function (err) { T.ok('stale publish ok (tombstoned)', !err); });
        T.eq('stale → one tombstone published', published.length, 1);
        T.eq('tombstone pair disabled', published[0].pairs.USDT.en, false);
        T.eq('tombstone no levels', [published[0].pairs.USDT.bids.length, published[0].pairs.USDT.asks.length], [0, 0]);
        T.eq('withdrawn state set', MK._state().state.withdrawn, true);
        T.ok('currentOrder now declines all (armSafe empty)', Object.keys(MK.currentOrder().pairs).length === 0);

        // ---- manual ladder publish ----
        PEG._reset();
        MK.saveConfig({ pegEnable: false, min: 2 }, { bids: [{ p: 0.98, a: 50 }], asks: [{ p: 1.02, a: 50 }] }, function () {});
        published.length = 0;
        MK.publish({ minima: 500, usdt: 500 }, function (err) { T.ok('manual publish ok', !err); });
        T.eq('manual ladder bid', published[0].pairs.USDT.bids[0].p, 0.98);
        T.eq('manual ladder ask', published[0].pairs.USDT.asks[0].p, 1.02);
        T.eq('manual scalar mirrors best', [published[0].pairs.USDT.buy, published[0].pairs.USDT.sell], [1.02, 0.98]);

        // ---- keep-alive: reprice when the mid moved past the threshold ----
        PEG._reset(); PEG._setPrice(1.0, 0);
        MK.saveConfig({ pegEnable: true, step: 1, size: 10, levels: 1, reprice: 1 }, { bids: [], asks: [] }, function () {});
        MK.publish({ minima: 500, usdt: 500 }, function () {});   // baseline lastMid=1.0
        MK._setLastPublish(Date.now() - 10 * 60000);   // outside the 3min spam floor
        PEG._setPrice(1.05, 0);   // +5% move ≥ 1% threshold
        published.length = 0;
        MK.keepAlive({ minima: 500, usdt: 500 }, function () {});
        T.eq('reprice republished', published.length, 1);

        // no move → no republish (within keep-alive interval)
        PEG._setPrice(1.05, 0);   // same as last
        MK._setLastPublish(Date.now());
        published.length = 0;
        MK.keepAlive({ minima: 500, usdt: 500 }, function () {});
        T.eq('no move, fresh publish → no republish', published.length, 0);

        // ---- currency switch tombstones the old market ----
        published.length = 0;
        MK.onCurrencySwitch({ minima: 500, usdt: 500 }, function () {});
        T.eq('switch tombstones old market', published.length, 1);
        T.eq('switch tombstone disabled', published[0].pairs.USDT.en, false);

        // ---- PER-CURRENCY kv keys (market memory): config parks under the ACTIVE currency's suffix, no bleed ----
        var ccyKey = TR.active().key;
        MK.saveConfig({ pegEnable: true, step: 2, size: 5, levels: 1 }, { bids: [], asks: [] }, function () {});
        T.ok('maker_cfg keyed per-currency', ('maker_cfg_' + ccyKey) in kv);
        T.ok('no un-suffixed maker_cfg written', !('maker_cfg' in kv));
        kv['maker_cfg_' + (ccyKey === 'mxusdt' ? 'minima' : 'mxusdt')] = JSON.stringify({ pegEnable: true, step: 9 });
        MK.loadConfig(function () {});
        T.eq('loadConfig reads ONLY the active currency (no bleed)', MK._state().cfg.step, 2);

        // ---- resetForReload (service currency-switch): drops the in-memory order + cfg without tombstoning ----
        published.length = 0;
        MK.resetForReload();
        T.eq('resetForReload publishes NOTHING (UI already tombstoned)', published.length, 0);
        T.eq('resetForReload cleared the live order', MK.currentOrder(), null);
        T.eq('resetForReload cleared the cfg cache', Object.keys(MK._state().cfg).length, 0);
    } finally {
        MDS.kvGet = savedGet; MDS.kvSet = savedSet; B.publishFresh = savedPub;
    }
})();
