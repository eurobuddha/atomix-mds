/**
 * app — the browser controller. Boots identity, configures the taker engine (ETH RPC + wallet + swap identity),
 * wires the UI's read-refresh handlers to the live node (order book, balances, activity), drives the poll cadence,
 * and drives the TAKER path: review (single or best-price-first sweep) → lock, with the maker-live chokepoint and
 * the buy handshake. Settlement (claims/refunds) runs in service.js (Phase 4). Requires the AX.* stack + AX.ui.
 * Attaches to AX.app.
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    var M = AX.mds, TR = AX.trading, B = AX.book, UI = AX.ui, F = AX.flow,
        EO = AX.ethops, EN = AX.engine, SP = AX.swapplan, DEC = AX.dec, FMT = AX.fmt;
    var EPS = 1e-9;
    var rpc = null;

    function start() {
        AX.boot.init(function (err, ctx) {
            if (err) { UI.state.paired = false; toast('Boot failed: ' + err.message); UI.render(); return; }
            UI.state.ctx = ctx; UI.state.paired = true;
            // configure the taker engine: ETH RPC + wallet key + my swap identity key (from the HTLC getaddress).
            rpc = new AX.ethrpc.Rpc(EO.NET.rpcs[0]);
            EN.configure({ rpc: rpc, ethPriv: ctx.eth.privKey, ethAddr: ctx.eth.address,
                myMinimaPk: ctx.htlc.publickey, onSwapsChanged: refreshSwaps });
            UI.onRefreshBook = refreshBook; UI.onRefreshBal = refreshBalances; UI.onEnterBookTab = refreshBook;
            UI.onThemeSaved = function (dark) { M.kvSet('theme', dark ? 'dark' : 'light'); };
            UI.onSwitchCurrency = switchCurrency;
            UI.onReview = onReview;
            UI.onTake = onTake;
            UI.onPublish = onPublish;
            UI.onSaveOrder = onSaveOrder;
            UI.onWithdraw = onWithdraw;
            UI.toast = toast;
            // maker controller (browser side): the UI publishes on user action; the service keeps it alive.
            AX.maker.configure({ identity: AX.boot.activeIdentity(ctx), myMinimaPk: ctx.htlc.publickey, ethAddr: ctx.eth.address,
                notify: function (t, b) { toast(t + ' — ' + b); }, onOrder: function () { } });
            AX.maker.loadConfig(function () { UI.state.makerCfg = AX.maker._state().cfg; });
            M.kvGet('theme', 'dark', function (t) {
                UI.dark = (t !== 'light');
                document.documentElement.setAttribute('data-theme', UI.dark ? 'dark' : 'light');
                UI.render();
                refreshBlock(); refreshBalances(); refreshEthBalances(); refreshBook(); refreshSwaps();
                setInterval(function () {
                    refreshBlock(); refreshBalances(); refreshEthBalances();
                    if (UI.state.tab === 'swap' || UI.state.tab === 'market') refreshBook();
                    refreshSwaps();
                }, 90000);
            });
        });
    }

    function myId() { return UI.state.ctx ? AX.boot.activeIdentity(UI.state.ctx).publicId() : null; }
    function ccy() { return TR.active().coinLabel; }
    function buySlippage() { return (AX.ui.slip || 0) / 100; }

    // ---------- reads ----------
    function refreshBlock() { M.cmdR('block', function (err, r) { if (!err && r) { UI.block = r.block || r; UI.render(); } }); }
    function refreshBook() { if (UI.state.ctx) B.scan(function (err, book) { if (!err) { UI.state.book = book; UI.setState({ book: book }); } }); }
    function refreshBalances() {
        M.cmdR('balance tokenid:' + TR.active().tokenId, function (err, r) {
            if (!err && r && r[0]) UI.state.bals.minima = trim6(r[0].sendable);
            UI.render();
        });
    }
    /** ETH + USDT balances via the ETH RPC (read-only): getBalance(18dp) + ERC20 balanceOf(6dp). */
    function refreshEthBalances() {
        if (!UI.state.ctx || !rpc) return;
        var addr = UI.state.ctx.eth.address;
        rpc.getBalance(addr, function (e, wei) { if (!e) { UI.state.bals.eth = trim6(DEC.formatUnits(wei, 18)); UI.render(); } });
        EO.make(rpc, UI.state.ctx.eth.privKey, addr).balanceOf(EO.NET.usdt, function (e, raw) { if (!e) { UI.state.bals.usdt = DEC.formatUnits(raw, 6); UI.render(); } });
    }
    function refreshSwaps() {
        M.sql('SELECT * FROM swaps ORDER BY created DESC', function (r) {
            if (r && r.status && r.rows) {
                UI.state.swaps = r.rows.map(function (row) {
                    return { hash: row.HASH, role: row.ROLE, direction: row.DIRECTION, selltoken: row.SELLTOKEN,
                        sellamount: row.SELLAMOUNT, buytoken: row.BUYTOKEN, buyamount: row.BUYAMOUNT, status: row.STATUS };
                });
                UI.render();
            }
        });
    }

    function switchCurrency(target) {
        // 0.1.5 parity: tombstone the OLD market + wipe the peg BEFORE switching, so a maker order in the old
        // currency doesn't stay live (mispriced) after the switch. Then flip currency + re-read the new book.
        AX.maker.onCurrencySwitch(makerBalances(), function () {
            M.kvSet('trading_currency', target.key, function () {
                TR.setActive(target);
                UI.state.book = {}; UI.state.quote = null; UI.state.amount = ''; UI.state.makerCfg = null; UI.state.editing = false;
                AX.maker.loadConfig(function () { UI.state.makerCfg = AX.maker._state().cfg; UI.render(); refreshBalances(); refreshEthBalances(); refreshBook(); });
            });
        });
    }

    // ---------- taker: route → review → lock ----------
    /** Route the Swap-tab CTA: within the best level → single swap; larger → best-price-first market sweep.
     *  state.amount is the mxUSDT (ccy) amount for BOTH directions (the ccy-anchored field). */
    function onReview(state) {
        var sell = state.sell, amtStr = state.amount;
        if (!amtStr) { toast('Enter how much ' + ccy() + ' to ' + (sell ? 'sell' : 'buy')); return; }
        refreshBook();   // kick a fresh scan (async) so the startLeg liveness guard re-checks the fresh book
        var q = B.bestMakers(state.book, myId());
        var bestMaker = sell ? q.bidMaker : q.askMaker;
        var bestPrice = sell ? q.bestBid : q.bestAsk;
        var bestCap = sell ? q.bidCap : q.askCap;
        if (!bestMaker || bestPrice <= 0) { toast('No quote available right now.'); return; }
        var want = Number(amtStr);
        if (!(want > 0)) { toast('Enter a valid ' + ccy() + ' amount.'); return; }

        if (sell) {
            if (want > Number(state.bals.minima) + EPS) { toast('You only have ~' + FMT.abbrev(Number(state.bals.minima)) + ' ' + ccy() + ' to sell.'); return; }
            if (want <= bestCap + EPS) { reviewSingle(bestMaker, amtStr, bestPrice, bestCap); return; }
            var plan = SP.buildSweepPlan(state.book, true, amtStr, 0, myId());
            if (!plan.legs.length) { toast(sweepEmptyMsg(plan)); return; }
            reviewSweep(plan); return;
        }
        // BUY: mxUSDT-target-driven with slippage; the whole spend must fit the USDT balance.
        var bplan = SP.buildSweepPlan(state.book, false, amtStr, buySlippage(), myId());
        if (!bplan.legs.length) { toast(sweepEmptyMsg(bplan)); return; }
        if (bplan.totalUsdt > Number(state.bals.usdt) + EPS) {
            toast('Need ≈ ' + trimSig(bplan.totalUsdt) + ' USDT for ' + FMT.abbrev(bplan.filledMinima) + ' ' + ccy() + ' — you have ' + trimSig(Number(state.bals.usdt)) + '.'); return;
        }
        reviewSweep(bplan);
    }

    function sweepEmptyMsg(p) { return p.stopReason === 'below-min' ? "That's below the makers' minimum trade size." : 'No liquidity available to fill that right now.'; }

    /** SELL single swap — sized within one maker's best level. */
    function reviewSingle(maker, ccyAmt, price, cap) {
        var minima = SP.legMinima(Number(ccyAmt)), usdt = SP.computeUsdt(minima, price);
        if (!minima || !usdt) { toast('Enter a valid amount'); return; }
        if (cap > 0 && Number(minima) > cap + EPS) { toast('Best level takes up to ' + FMT.abbrev(cap) + ' ' + ccy() + ' — reduce the amount'); return; }
        UI.dialog({
            title: 'Review — Sell ' + ccy(),
            lines: [
                { text: 'Sell  ' + minima + ' ' + ccy() },
                { text: 'Receive  ≈ ' + usdt + ' USDT' },
                { text: 'Best price ' + FMT.px(price) + ' USDT/' + ccy(), cls: 'dim' },
                { text: 'Counterparty  ' + FMT.shorten(maker.signerPk), cls: 'dim' },
                { text: 'This locks your ' + ccy() + ' on-chain.', cls: 'dim' }
            ],
            confirmText: 'Start swap',
            onConfirm: function () { startSingle(maker, true, minima, usdt); }
        });
    }

    /** Multi-leg sweep (SELL split, or any BUY) — blended metrics + per-part breakdown + totals + partial note. */
    function reviewSweep(plan) {
        var sell = plan.sell, n = plan.legs.length;
        var lines = [{ text: 'Avg ' + FMT.px(plan.avgPrice) + '  ·  worst ' + FMT.px(plan.worstPrice) + ' USDT/' + ccy()
            + (!sell && plan.slippagePct > 0 ? '  ·  within ' + trimSig(plan.slippagePct) + '% slippage' : ''), cls: 'dim' }];
        plan.legs.forEach(function (leg, i) {
            lines.push({ text: 'Part ' + (i + 1) + ' · ' + leg.minima + ' ' + ccy() + ' @ ' + FMT.px(leg.price) + ' → ' + leg.usdt + ' USDT · ' + FMT.shorten(leg.maker.signerPk), cls: 'mono' });
        });
        lines.push({ text: sell ? ('Total: sell ' + trimSig(plan.filledMinima) + ' ' + ccy() + ' · receive ≈ ' + trimSig(plan.totalUsdt) + ' USDT')
            : ('Total: pay ≈ ' + trimSig(plan.totalUsdt) + ' USDT · receive ≈ ' + trimSig(plan.filledMinima) + ' ' + ccy()), cls: 'accent' });
        if (plan.partial) lines.push({ text: 'Fills ' + FMT.abbrev(plan.filledMinima) + ' of ' + FMT.abbrev(plan.target) + ' ' + ccy() + ' — '
            + (!sell && plan.stopReason === 'slippage' ? 'the rest is priced beyond your ' + trimSig(plan.slippagePct) + '% slippage.' : "the rest isn't available in the book right now."), cls: 'red' });
        if (!sell) lines.push({ text: 'Each part is a separate Ethereum transaction — you pay ETH gas ' + n + (n === 1 ? ' time.' : ' times.'), cls: 'dim' });
        UI.dialog({
            title: sell ? ('Sell ' + FMT.abbrev(plan.filledMinima) + ' ' + ccy() + ' in ' + n + (n === 1 ? ' part' : ' parts'))
                : ('Buy ≈ ' + FMT.abbrev(plan.filledMinima) + ' ' + ccy() + ' for ≈ ' + trimSig(plan.totalUsdt) + ' USDT in ' + n + (n === 1 ? ' part' : ' parts')),
            lines: lines, confirmText: n > 1 ? 'Start sweep' : 'Start swap',
            onConfirm: function () { startSweep(plan); }
        });
    }

    function makeHooks(maker, sellMinima) {
        return {
            makerLive: function () { return B.makerLive(UI.state.book[maker.signerPk], sellMinima); },
            me: AX.boot.activeIdentity(UI.state.ctx),
            myPublicId: myId(),
            onWithdrawn: function () { refreshBook(); },
            onNote: function (tag) {
                if (tag === 'buy-notified') UI.setStatus('✓ Buy started — maker notified, watching.');
                else if (tag && tag.indexOf('buy-notify-failed') === 0) UI.setStatus('Buy locked, but maker notify failed.');
            }
        };
    }

    function startSingle(maker, sellMinima, minima, usdt) {
        UI.setStatus('Starting swap…');
        EN.startLeg(maker, 'USDT', sellMinima, minima, usdt, makeHooks(maker, sellMinima), function (err, hash) {
            if (err) { UI.setStatus('Swap failed: ' + err.message); return; }
            UI.setStatus('✓ Swap started — leg 1 locked. Watching for the counterparty.');
            UI.state.amount = ''; refreshSwaps();
        });
    }

    // SELL legs lock unpinned mxUSDT coins → serialize each on its on-chain confirm so two legs can't double-select.
    // BUY legs are nonce-serialized by EthTx → fire back-to-back.
    function startSweep(plan) {
        if (!plan.legs.length) return;
        UI.state.amount = '';
        if (plan.sell) startSweepSell(plan, 0, 0); else startSweepBuy(plan);
    }
    function startSweepSell(plan, i, ok) {
        if (i >= plan.legs.length) { UI.setStatus('✓ Sweep done — ' + ok + '/' + plan.legs.length + ' parts locked.'); refreshSwaps(); return; }
        var leg = plan.legs[i];
        UI.setStatus('Locking part ' + (i + 1) + '/' + plan.legs.length + '…');
        EN.startLeg(leg.maker, 'USDT', true, leg.minima, leg.usdt, makeHooks(leg.maker, true), function (err, hash) {
            if (err) { UI.setStatus('Sweep stopped at part ' + (i + 1) + ': ' + err.message); refreshSwaps(); return; }
            refreshSwaps();
            // Gate the next leg on THIS one confirming on-chain — an unconfirmed coin must never be raced by the
            // next unpinned mxUSDT lock (double-select). If it doesn't confirm in time, STOP (a partial sweep is
            // safe); don't proceed and risk selecting the just-spent coin.
            pollConfirm(hash, true, function (confirmed) {
                if (confirmed) return startSweepSell(plan, i + 1, ok + 1);
                UI.setStatus('Locked ' + (ok + 1) + '/' + plan.legs.length + ' parts — part ' + (i + 1) + ' is still confirming; remaining parts not sent. Try again shortly.');
                refreshSwaps();
            });
        });
    }
    function startSweepBuy(plan) {
        UI.setStatus('Starting ' + plan.legs.length + ' buy part' + (plan.legs.length === 1 ? '' : 's') + '…');
        var done = 0, ok = 0;
        plan.legs.forEach(function (leg) {
            EN.startLeg(leg.maker, 'USDT', false, leg.minima, leg.usdt, makeHooks(leg.maker, false), function (err) {
                done++; if (!err) ok++;
                if (done === plan.legs.length) { UI.setStatus('✓ ' + ok + '/' + plan.legs.length + ' buy part' + (plan.legs.length === 1 ? '' : 's') + ' started.'); refreshSwaps(); }
            });
        });
    }
    /** Poll confirmMyLock until the leg is on-chain (or a ~2min cap). cb(confirmed) — false on timeout so the
     *  caller can STOP rather than race an unconfirmed coin. */
    function pollConfirm(hash, sell, cb) {
        var tries = 0;
        (function loop() {
            EN.confirmMyLock(hash, sell, function (found) {
                if (found) return cb(true);
                if (++tries > 24) return cb(false);
                setTimeout(loop, 5000);
            });
        })();
    }

    // ---------- maker: publish / edit / withdraw ----------
    function makerBalances() { return { minima: Number(UI.state.bals.minima) || 0, usdt: Number(UI.state.bals.usdt) || 0 }; }
    function onPublish() {
        AX.maker.refreshPeg(function () {
            UI.setStatus('Publishing your market…');
            AX.maker.publish(makerBalances(), function (err) {
                UI.setStatus(err ? ('Publish failed: ' + err.message) : '✓ Market published.');
                refreshBook();
            });
        });
    }
    function onSaveOrder(cfg, manual) {
        AX.maker.saveConfig(cfg, manual, function () {
            UI.state.makerCfg = cfg;
            AX.maker.refreshPeg(function () {
                UI.setStatus('Publishing your market…');
                AX.maker.publish(makerBalances(), function (err) {
                    UI.setStatus(err ? ('Publish failed: ' + err.message) : '✓ Market saved + published.');
                    refreshBook();
                });
            });
        });
    }
    function onWithdraw() {
        AX.maker.tombstone(makerBalances(), function (err) {
            UI.setStatus(err ? ('Withdraw failed: ' + err.message) : 'Market withdrawn.');
            refreshBook();
        });
    }

    /** Tapping a market depth row: set the direction (bid → I sell, ask → I buy) and open the Swap tab to size it. */
    function onTake(maker, isBid) {
        UI.state.sell = isBid; UI.state.tab = 'swap'; UI.render();
        toast('Enter an amount to ' + (isBid ? 'sell' : 'buy') + ' — the best price is used.');
    }

    // ---------- helpers ----------
    function toast(msg) {
        var t = document.getElementById('toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
        t.textContent = msg; t.className = 'show';
        clearTimeout(toast._t); toast._t = setTimeout(function () { t.className = ''; }, 2200);
    }
    function trim6(v) { var n = parseFloat(v); return isFinite(n) ? (Math.round(n * 1e6) / 1e6).toString() : '0'; }
    function trimSig(n) { n = Number(n); return isFinite(n) ? (Math.round(n * 1e6) / 1e6).toString() : '0'; }

    // onBalance: NEWBALANCE fires on a Minima balance change — refresh the (cheap) node balance; ETH/USDT stay on
    // the 90s timer so a balance event can't hammer the shared public RPCs.
    AX.app = { start: start, onBalance: function () { refreshBalances(); } };
})(typeof globalThis !== 'undefined' ? globalThis : this);
