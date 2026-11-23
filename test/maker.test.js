// review 7 Nov: this suite drives normal ask publishing, which ships PAUSED (AX.htlc.ETH_FIRST_PAUSED) until HTLC v1.3
var __ethFirstWasM = AX.htlc.ETH_FIRST_PAUSED; AX.htlc.ETH_FIRST_PAUSED = false;
/* maker — build order from config, publish (pegged + manual), tombstone, keep-alive/reprice, currency switch. */
(function () {
    var MK = AX.maker, O = AX.order, B = AX.book, PEG = AX.peg, TR = AX.trading, MDS = AX.mds;

    // in-memory kv (maker persists config/state through AX.mds.kvGet/kvSet)
    var kv = {}, savedGet = MDS.kvGet, savedSet = MDS.kvSet, savedDel = MDS.kvDel;
    MDS.kvGet = function (k, d, cb) { cb(k in kv ? kv[k] : d); };
    MDS.kvSet = function (k, v, cb) { kv[k] = v; cb && cb(null); };
    MDS.kvDel = function (k, cb) { delete kv[k]; cb && cb(null); };
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
        T.eq('a live manual publish clears the withdrawn flag the tombstone set', MK._state().state.withdrawn, false);
        T.eq('…and it is persisted (the screen reads peg_state)', JSON.parse(kv[Object.keys(kv).filter(function (k) { return /^peg_state/.test(k); })[0]]).withdrawn, false);

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

        // ---- 0.1.64: a failed balance read is never published as 0 (it took the market off every book) ----
        MK._setLastPublish(0);   // keep-alive due
        published.length = 0;
        [null, undefined, { minima: NaN, usdt: 500 }, { minima: 500 }, { minima: '500', usdt: 500 }].forEach(function (a) { MK.keepAlive(a, function () {}); });
        T.eq('failed balance read → nothing republished', published.length, 0);
        MK.keepAlive({ minima: 0, usdt: 500 }, function () {});
        T.eq('a real zero balance still republishes', published.length, 1);
        var SF = MK.sellableFrom;
        T.eq('sellableFrom: refused / pending / no answer → null', [SF(null), SF({ status: false, error: 'x' }), SF({ status: true, pending: true, response: [] }), SF({ status: true })], [null, null, null, null]);
        T.eq('sellableFrom: unreadable sendable → null', [SF({ status: true, response: [{}] }), SF({ status: true, response: [{ sendable: 'abc' }] }), SF({ status: true, response: [{ sendable: '' }] })], [null, null, null]);
        T.eq('sellableFrom: no coins of the token is a real 0', SF({ status: true, response: [] }), 0);
        T.eq('sellableFrom: the sendable figure', SF({ status: true, response: [{ sendable: '21615.6', confirmed: '21700' }] }), 21615.6);

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

        // ---- legacy-key migration: a pre-0.1.3 un-suffixed cfg is adopted into the active currency's keys ONCE ----
        delete kv['maker_cfg_' + ccyKey];
        kv['maker_cfg'] = JSON.stringify({ pegEnable: true, step: 7, size: 3, levels: 1 });
        kv['maker_manual'] = JSON.stringify({ bids: [{ p: 0.9, a: 1 }], asks: [] });
        MK.loadConfig(function () {});
        T.eq('legacy cfg adopted on first load', MK._state().cfg.step, 7);
        T.ok('legacy migrated to the per-currency key', ('maker_cfg_' + ccyKey) in kv);
        T.ok('legacy keys deleted after adoption', !('maker_cfg' in kv) && !('maker_manual' in kv));
        T.eq('legacy manual ladder carried over', MK._state().manual.bids.length, 1);

        // ---- 0.1.33: a FAILED tombstone aborts the switch (error reported, state untouched) ----
        B.publishFresh = function (me, order, cb) { cb(new Error('cmd failed: send — Insufficient funds.. you only have 0')); };
        var switchErr = null; MK.onCurrencySwitch({ minima: 500, usdt: 500 }, function (e) { switchErr = e; });
        T.ok('tombstone failure is reported to the switch caller', switchErr && /Insufficient funds/.test(switchErr.message));
        B.publishFresh = function (me, order, cb) { published.push(order); cb(null); };

        // ---- 0.1.33: keep-alive re-reads the shared currency and stands down if another context switched it ----
        MK.saveConfig({ pegEnable: false, step: 1, size: 10, bias: 0, levels: 1, min: 1, reprice: 1 }, { bids: [{ p: 0.99, a: 100 }], asks: [] }, function () {});
        MK._setLastPublish(0); published.length = 0;
        kv.trading_currency = TR.active().key === 'minima' ? 'mxusdt' : 'minima';   // the page moved the kv mid-pass
        MK.keepAlive({ minima: 500, usdt: 500 }, function () {});
        T.eq('keep-alive publishes nothing when the kv currency differs from the one it was configured for', published.length, 0);
        kv.trading_currency = TR.active().key;
        MK.keepAlive({ minima: 500, usdt: 500 }, function () {});
        T.eq('keep-alive publishes once the kv agrees', published.length, 1);
        delete kv.trading_currency;

        // ---- A2 (0.1.69): an unreadable balance never disables the dead-feed safety ----
        var notes = [], tNow = 5e12;
        MK.configure({ identity: identity, myMinimaPk: '0xMYPK', ethAddr: '0xETH', notify: function (a, b) { notes.push(a + ' | ' + b); }, onOrder: function () {} });
        MK._setNow(function () { return tNow; }); MK._resetBalanceWatch();
        T.eq('publish refuses an unread balance (no order stamped 0)', (function () { var e0 = null; published.length = 0; MK.publish(null, function (e) { e0 = e; }); return [!!e0, published.length]; })(), [true, 0]);
        PEG._reset(); PEG._setPrice(1.0, 0);
        MK.saveConfig({ pegEnable: true, step: 1, size: 10, levels: 1, reprice: 1 }, { bids: [], asks: [] }, function () {});
        MK.publish({ minima: 500, usdt: 500 }, function () {});
        T.ok('pegged market live before the feed dies', MK.currentOrder() && MK.currentOrder().pairs.USDT && MK.currentOrder().pairs.USDT.asks.length === 1);
        published.length = 0;
        MK.keepAlive(null, function () {});
        T.eq('unread balance + fresh price → the market stands, nothing published', published.length, 0);
        PEG._setPrice(1.0, PEG.HARD_STALE_MS + 60000);   // the feed is now past the hard ceiling: PEG_STALE
        MK.keepAlive(null, function () {});
        T.eq('unread balance + PEG_STALE → tombstoned all the same', [published.length, published[0] && published[0].pairs.USDT.en], [1, false]);
        T.eq('… and marked withdrawn', MK._state().state.withdrawn, true);
        T.ok('… so takes are declined (armSafe empty)', Object.keys(MK.currentOrder().pairs).length === 0);
        MK.keepAlive(null, function () {});
        T.eq('… once: an already-withdrawn market is not tombstoned again every pass', published.length, 1);
        // reads failing longer than KEEPALIVE_MS: told once, and the live ladder stops answering takes
        PEG._setPrice(1.0, 0); MK._resetBalanceWatch();
        MK.publish({ minima: 500, usdt: 500 }, function () {});
        notes.length = 0; MK.keepAlive(null, function () {});
        tNow += MK.KEEPALIVE_MS - 1000; MK.keepAlive(null, function () {});
        T.ok('reads failing < KEEPALIVE_MS → ladder still answers', MK.currentOrder() && MK.currentOrder().pairs.USDT && MK.currentOrder().pairs.USDT.asks.length === 1);
        T.eq('… and no notice yet', notes.filter(function (n) { return /^Balance unreadable/.test(n); }).length, 0);
        tNow += 2000; MK.keepAlive(null, function () {}); tNow += 60000; MK.keepAlive(null, function () {});
        T.eq('reads failing > KEEPALIVE_MS → told exactly once', notes.filter(function (n) { return /^Balance unreadable/.test(n); }).length, 1);
        T.ok('… and currentOrder() declines every take', Object.keys(MK.currentOrder().pairs).length === 0);
        MK.keepAlive({ minima: 500, usdt: 500 }, function () {});
        T.ok('a good read restores the live ladder', MK.currentOrder() && MK.currentOrder().pairs.USDT && MK.currentOrder().pairs.USDT.asks.length === 1);
        MK._setNow(Date.now); MK._resetBalanceWatch();
    } finally {
        MDS.kvGet = savedGet; MDS.kvSet = savedSet; MDS.kvDel = savedDel; B.publishFresh = savedPub;
    }
})();
AX.htlc.ETH_FIRST_PAUSED = __ethFirstWasM;
