/**
 * app — the browser controller. Boots identity, configures the taker engine (ETH RPC + wallet + swap identity),
 * wires the UI's read-refresh handlers to the live node (order book, balances, activity), drives the poll cadence,
 * and drives the TAKER path: review (single or best-price-first sweep) → lock, with the maker-live chokepoint and
 * the buy handshake. Settlement (claims/refunds) runs ONLY in service.js. Requires the AX.* stack + AX.ui.
 * Attaches to AX.app.
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    var M = AX.mds, TR = AX.trading, B = AX.book, UI = AX.ui, F = AX.flow,
        EO = AX.ethops, EN = AX.engine, SP = AX.swapplan, DEC = AX.dec, FMT = AX.fmt;
    var EPS = 1e-9;
    var BOOT_RETRY_MS = 15000;   // self-heal: re-check after the user grants WRITE trust / unlocks the vault
    var rpc = null, booting = false, bootTimer = null;

    function start() {
        UI.onRetryBoot = attemptBoot;
        attemptBoot();
    }

    /** Run the boot sequence; on failure show the SPECIFIC instruction card (permission / locked / other) and
     *  keep retrying — so granting WRITE trust in the hub brings the app up without a reload. Re-entry guarded. */
    function attemptBoot() {
        if (booting || UI.state.paired) return;
        booting = true;
        clearTimeout(bootTimer);
        AX.boot.init(function (err, ctx) {
            booting = false;
            if (err) {
                UI.state.paired = false;
                UI.state.bootError = { permission: !!err.permission, locked: !!err.locked, message: err.message };
                UI.render();
                bootTimer = setTimeout(attemptBoot, BOOT_RETRY_MS);
                return;
            }
            UI.state.bootError = null;
            onBooted(ctx);
        });
    }

    function onBooted(ctx) {
            UI.state.ctx = ctx; UI.state.paired = true;
            // configure the taker engine: ETH RPC + wallet key + my swap identity key (from the HTLC getaddress).
            rpc = new AX.ethrpc.Rpc(EO.NET.rpcs[0]);
            EN.configure({ rpc: rpc, ethPriv: ctx.eth.privKey, ethAddr: ctx.eth.address,
                myMinimaPk: ctx.htlc.publickey, onSwapsChanged: refreshSwaps });
            UI.onRefreshBook = refreshBook;
            UI.onEnterBookTab = function () { refreshBook(); refreshMarketHistory(); };
            UI.onRefreshBal = function () { toast('Refreshing balances…'); refreshBalances(); refreshEthBalances(); };   // native parity: both sides
            UI.onCopy = copyText; UI.onCoinDump = onCoinDump; UI.onSendMax = onSendMax; UI.onSendReview = onSendReview;
            UI.onSwapDetail = onSwapDetail;
            UI.onExportCsv = onExportCsv;
            UI.onThemeSaved = function (dark) { M.kvSet('theme', dark ? 'dark' : 'light'); };
            UI.onSwitchCurrency = switchCurrency;
            UI.onReview = onReview;
            UI.onTake = onTake;
            UI.onPublish = onPublish;
            UI.onSaveOrder = onSaveOrder;
            UI.onWithdraw = onWithdraw;
            UI.toast = toast;
            // maker controller (browser side): the UI publishes on user action; the service keeps it alive.
            // OTC negotiation (browser): the UI drives PROPOSE/COUNTER/ACCEPT + executes leg 1 on the instigator side.
            // configureMakerOtc RE-RUNS on a currency switch — these contexts CAPTURE the active identity, and a
            // stale capture publishes/signs the new currency's book as the OLD currency (0.1.2-regression class).
            configureMakerOtc(ctx);
            AX.maker.loadConfig(function () { var st = AX.maker._state(); UI.state.makerCfg = st.cfg; UI.state.makerManual = st.manual; });
            UI.onOtcGoLive = onOtcGoLive; UI.onOtcWithdraw = onOtcWithdraw; UI.onOtcPropose = onOtcPropose;
            UI.onOtcAccept = onOtcAccept; UI.onOtcCounter = onOtcCounter; UI.onOtcReject = onOtcReject;
            AX.otc.initDb(function () { refreshOtc(); });
            M.kvGet('theme', 'dark', function (t) {
                UI.dark = (t !== 'light');
                document.documentElement.setAttribute('data-theme', UI.dark ? 'dark' : 'light');
                UI.render();
                refreshBlock(); refreshBalances(); refreshEthBalances(); refreshBook(); refreshSwaps();
                UI.onEnterOtc = refreshOtc;
                setInterval(function () {
                    refreshBlock(); refreshBalances(); refreshEthBalances();
                    if (UI.state.tab === 'swap' || UI.state.tab === 'market') refreshBook();
                    if (UI.state.tab === 'market') refreshMarketHistory();
                    refreshSwaps();
                    if (UI.state.tab === 'otc') refreshOtc();
                }, 90000);
                // first-run welcome (native showWelcome — once, then via the header ? pill)
                M.kvGet('seen_welcome', '', function (v) {
                    if (!v) { UI.welcomeDialog(); M.kvSet('seen_welcome', '1', function () { }); }
                });
            });
    }

    /** (Re)wire the identity-capturing contexts for the ACTIVE currency — at boot and after every switch. */
    function configureMakerOtc(ctx) {
        AX.maker.configure({ identity: AX.boot.activeIdentity(ctx), myMinimaPk: ctx.htlc.publickey, ethAddr: ctx.eth.address,
            notify: function (t, b) { toast(t + ' — ' + b); }, onOrder: function () { } });
        AX.otc.configure({ identity: AX.boot.activeIdentity(ctx), myMinimaPk: ctx.htlc.publickey, ethAddr: ctx.eth.address,
            notify: function (t, b) { toast(t + ' — ' + b); }, onDealsChanged: refreshDeals,
            onExecute: function (deal, cb) { AX.engine.executeOtc(deal, cb); }, onIncomingHash: function () { } });
    }

    function myId() { return UI.state.ctx ? AX.boot.activeIdentity(UI.state.ctx).publicId() : null; }
    function ccy() { return TR.active().coinLabel; }
    function buySlippage() { return (AX.ui.slip || 0) / 100; }

    // ---------- reads ----------
    function refreshBlock() { M.cmdR('block', function (err, r) { if (!err && r) { UI.block = r.block || r; UI.render(); } }); }
    function refreshBook() { if (UI.state.ctx) B.scan(function (err, book) { if (!err) { UI.state.book = book; UI.setState({ book: book }); } }); }
    /** Arm a one-shot balance pulse (native firePendingPulses) when a displayed value actually changed. */
    function armPulse(key, oldVal, newVal) {
        if (oldVal !== '0' && oldVal !== newVal) { UI.state.pulse = UI.state.pulse || {}; UI.state.pulse[key] = true; }
    }
    function refreshBalances() {
        M.cmdR('balance tokenid:' + TR.active().tokenId, function (err, r) {
            if (!err && r && r[0]) {
                armPulse('minima', UI.state.bals.minima, trim6(r[0].sendable));
                UI.state.bals.minima = trim6(r[0].sendable);
                // Minima card breakdown (native minimaBreakdown parity): keep the full balance shape + a stamp.
                UI.state.balsMeta = { confirmed: r[0].confirmed, unconfirmed: r[0].unconfirmed,
                    sendable: r[0].sendable, coins: r[0].coins, at: Date.now() };
            }
            UI.render();
        });
    }
    /** ETH + USDT balances via the ETH RPC (read-only): getBalance(18dp) + ERC20 balanceOf(6dp). RAW values are
     *  kept too — send validation must never trust the rounded display strings. */
    function refreshEthBalances() {
        if (!UI.state.ctx || !rpc) return;
        var addr = UI.state.ctx.eth.address;
        // Native fetchEthBalances (m:732) parity: an all-RPC failure shows '—' AND surfaces the reason, and the
        // NEXT good read clears it. ethErr is assigned unconditionally — set-only would pin the banner until
        // reload after one transient RPC/DNS blip (the native 0.1.12 bug fixed in 0.1.13).
        rpc.getBalance(addr, function (e, wei) {
            UI.state.ethErr = e ? (e.message || String(e)) : null;
            if (e) { UI.state.bals.eth = '—'; UI.render(); return; }
            UI.state.balsRaw.ethWei = wei.toString(); armPulse('eth', UI.state.bals.eth, trim6(DEC.formatUnits(wei, 18))); UI.state.bals.eth = trim6(DEC.formatUnits(wei, 18)); UI.render();
        });
        // Per-token failure is reported in the token's own card ('—'), never in the ETH banner — native m:750.
        EO.make(rpc, UI.state.ctx.eth.privKey, addr).balanceOf(EO.NET.usdt, function (e, raw) {
            if (e) { UI.state.bals.usdt = '—'; UI.render(); return; }
            UI.state.balsRaw.usdtRaw = raw.toString(); armPulse('usdt', UI.state.bals.usdt, DEC.formatUnits(raw, 6)); UI.state.bals.usdt = DEC.formatUnits(raw, 6); UI.render();
        });
    }

    // ---------- market history (page READS the service-collected SQL; never writes) ----------
    function refreshMarketHistory() {
        AX.swapdb.executedTrades(200, function (e, chart) {
            AX.swapdb.recentTrades(50, function (e2, recent) {
                UI.state.market = { chart: chart || [], recent: recent || [] };
                UI.render();
            });
        });
    }

    // ---------- swap inspector (native checkNow/inspect: live both-legs report) ----------
    function usdtDp(tokenAddr) { return String(tokenAddr).toLowerCase() === EO.NET.usdt.toLowerCase() ? EO.NET.usdtDecimals : 18; }
    function onSwapDetail(hash) {
        toast('Checking…');
        var DB = AX.swapdb, H = AX.htlc, ctx = UI.state.ctx;
        DB.getSwap(hash, function (e, s) {
            if (!s) return UI.swapReportDialog(hash, ['No record of this swap.']);
            H.currentBlock(function (eB, block) {
                if (eB) block = -1;
                H.scanByHash(hash, 2, 256, function (eS, coins) {
                    var myMin = null, cpMin = null, myPk = ctx.htlc.publickey;
                    (coins || []).forEach(function (c) {
                        if (!c || H.normKey(H.stateAt(c, 5) || '') !== H.normKey(hash)) return;
                        if (H.normKey(H.stateAt(c, 0) || '') === H.normKey(myPk)) myMin = c;
                        if (H.normKey(H.stateAt(c, 4) || '') === H.normKey(myPk)) cpMin = c;
                    });
                    DB.getSecret(hash, function (e2, secret) {
                        DB.getEvents(hash, function (e3, events) {
                            var ops = EO.make(rpc, ctx.eth.privKey, ctx.eth.address);
                            var facts = { swap: s, block: block, secretKnown: !!secret, myMin: myMin, cpMin: cpMin,
                                gc: null, gcAmountHuman: '', myEthStillLocked: null, events: events || [] };
                            function report() { UI.swapReportDialog(hash, AX.inspect.buildReport(facts)); }
                            if (s.direction === 'MINIMA_TO_ERC20') {
                                ops.getContract(EO.contractId(hash), function (e4, gc) {
                                    if (gc) { facts.gc = gc; facts.gcAmountHuman = DEC.formatUnits(gc.amount, usdtDp(gc.tokenContract)); }
                                    report();
                                });
                            } else {
                                ops.canCollect(s.contractId, function (e4, still) { facts.myEthStillLocked = !e4 && !!still; report(); });
                            }
                        });
                    });
                });
            });
        });
    }

    // ---------- wallet: copy / coin dump / send (MDS-only send — see PARITY.md) ----------
    function copyText(text, doneMsg) {
        function fallback() {
            try {
                var ta = document.createElement('textarea');
                ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
                document.body.appendChild(ta); ta.select();
                document.execCommand('copy'); document.body.removeChild(ta);
                toast(doneMsg);
            } catch (e) { toast('Copy failed — select the text and copy manually'); }
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () { toast(doneMsg); }, fallback);
        } else fallback();
    }
    // Export ALL my swaps to a CSV — each row tagged Maker (RESPONDER) / Taker (INITIATOR), with the on-chain leg tx
    // ids joined from the events log. Same columns/format as the desktop + native peers. Saves to the MiniDapp file
    // area via MDS.file.save; on failure, falls back to copying the CSV to the clipboard.
    function axRoleLabel(r) { return r === 'RESPONDER' ? 'Maker' : (r === 'INITIATOR' ? 'Taker' : (r || '')); }
    function axDirLabel(d) { return d === 'MINIMA_TO_ERC20' ? 'Sell MINIMA' : (d === 'ERC20_TO_MINIMA' ? 'Buy MINIMA' : (d || '')); }
    function axIso(ms) { var n = Number(ms); return (n > 0 && isFinite(n)) ? new Date(n).toISOString() : ''; }
    function axPrice(s) {   // USDT per MINIMA, comparable across both directions
        var sell = parseFloat(s.sellAmount), buy = parseFloat(s.buyAmount);
        if (!(sell > 0) || !(buy > 0)) return '';
        var p = s.direction === 'MINIMA_TO_ERC20' ? buy / sell : (s.direction === 'ERC20_TO_MINIMA' ? sell / buy : 0);
        return p > 0 ? String(Number(p.toPrecision(8))) : '';
    }
    function axIsTx(v) { return /^0x[0-9a-fA-F]{16,}$/.test(String(v == null ? '' : v)); }
    function axPickTx(ev, minimaLeg) {   // events: {event,token,amount,note(=txnhash),date}; filter to real 0x ids
        var seen = [];
        for (var k = 0; k < ev.length; k++) {
            var e = ev[k];
            var m = minimaLeg ? (String(e.token) === 'minima') : (String(e.token || '').slice(0, 3) === 'ETH');
            if (m && axIsTx(e.note) && seen.indexOf(e.note) < 0) seen.push(e.note);
        }
        return seen.join(';');
    }
    function axCsvCell(v) {   // always quoted; neutralize spreadsheet formula-injection (leading = + - @ TAB CR)
        var s = String(v == null ? '' : v);
        if (s.length && '=+-@\t\r'.indexOf(s.charAt(0)) >= 0) s = "'" + s;
        return '"' + s.replace(/"/g, '""') + '"';
    }
    function axCsvRow(s, ev) {
        return [axIso(s.created), axRoleLabel(s.role), axDirLabel(s.direction),
            s.sellAmount, TR.labelForToken(s.sellToken), s.buyAmount, TR.labelForToken(s.buyToken), axPrice(s),
            s.counterparty, String(s.status == null ? '' : s.status).toLowerCase(), s.contractId,
            axPickTx(ev, true), axPickTx(ev, false)].map(axCsvCell).join(',');
    }
    function onExportCsv() {
        AX.swapdb.allSwaps(function (err, all) {
            if (err || !all || !all.length) { toast('No swaps to export'); return; }
            var lines = ['Date,Role,Direction,Sold Amount,Sold Token,Bought Amount,Bought Token,Price (USDT/MINIMA),Counterparty,Status,Contract Id,Minima Tx,Eth Tx'];
            var i = 0;
            (function next() {
                if (i >= all.length) return finish();
                var s = all[i++];
                AX.swapdb.getEvents(s.hash, function (e2, ev) { lines.push(axCsvRow(s, ev || [])); next(); });
            })();
            function finish() {
                var csv = lines.join('\r\n');
                try {
                    MDS.file.save('atomix-trades.csv', csv, function (r) {
                        if (r && r.status) toast('Saved ' + all.length + ' trades → atomix-trades.csv (MiniDapp files)');
                        else copyText(csv, 'File save failed — CSV copied to clipboard instead');
                    });
                } catch (ex) { copyText(csv, 'CSV copied to clipboard'); }
            }
        });
    }
    function onCoinDump() {
        M.cmdR('coins relevant:true sendable:true tokenid:' + TR.active().tokenId + ' coinage:1', function (err, resp) {
            var rows = (!err && Array.isArray(resp)) ? resp.map(function (c) {
                return { amount: AX.htlc.coinAmount(c), coinid: c.coinid || '' };
            }) : [];
            rows.sort(function (a, b) { return Number(b.amount) - Number(a.amount); });
            UI.coinsDialog(rows.slice(0, 50));
        });
    }
    /** Fill the Send form's Max: ETH = balance − gas reserve; USDT = full raw balance. */
    function onSendMax(asset, cb) {
        if (asset === 'usdt') return cb(DEC.formatUnits(BigInt(UI.state.balsRaw.usdtRaw), 6));
        rpc.gasPrice(function (e, gp) {
            if (e) { toast('Could not read gas price — try again'); return; }
            cb(DEC.formatUnits(AX.wallet.maxEthSendWei(BigInt(UI.state.balsRaw.ethWei), gp), 18));
        });
    }
    /** Validate + price the send, then show the review dialog; broadcast only on its confirm. */
    function onSendReview(asset, to, amt) {
        rpc.gasPrice(function (e, gp) {
            if (e) { toast('Could not read gas price — try again'); return; }
            var chk = AX.wallet.checkSend(asset, to, amt, BigInt(UI.state.balsRaw.ethWei), BigInt(UI.state.balsRaw.usdtRaw), gp);
            if (!chk.ok) { toast(chk.err); return; }
            var gasLimit = asset === 'eth' ? AX.wallet.GAS_ETH : AX.wallet.GAS_ERC20;
            var feeEth = trim6(DEC.formatUnits(AX.wallet.gasReserveWei(gp, gasLimit), 18));
            UI.sendReviewDialog(asset, to, amt, feeEth, function () { doSend(asset, to, amt); });
        });
    }
    function doSend(asset, to, amt) {
        var ctx = UI.state.ctx;
        UI.setStatus('Broadcasting…');
        var send = asset === 'eth' ? AX.wallet.sendEth : AX.wallet.sendUsdt;
        send(rpc, ctx.eth.privKey, ctx.eth.address, to, amt, function (err, txHash) {
            if (err) { UI.setStatus('Send failed: ' + err.message); return; }
            UI.state.sendForm = null;   // clear the form only after a successful broadcast
            UI.setStatus('✓ Sent — tx ' + AX.wallet.shortAddr(txHash) + ' (balance updates once mined)');
            setTimeout(refreshEthBalances, 15000);
            refreshEthBalances();
        });
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
            // 0.1.16 parity (native MainActivity.doSwitchCurrency): OTC quiesces WITH the order side. The OTC
            // board sentinel is per-currency, so an offer left armed here re-advertises the LEAVING currency's
            // sizes on the ARRIVING currency's board. Disarm only — the old board's coin ages out, exactly as
            // native leaves it; native additionally clears its persisted otc_enable/otc_auto, which the MDS has
            // no equivalent of (myOffer is in-memory and the service never arms it).
            AX.otc.setMyOffer(false, 0, 0);
            M.kvSet('trading_currency', target.key, function () {
                TR.setActive(target);
                configureMakerOtc(UI.state.ctx);   // re-capture the NEW currency's identity (maker + OTC contexts)
                UI.state.book = {}; UI.state.quote = null; UI.state.amount = ''; UI.state.makerCfg = null; UI.state.makerManual = null; UI.state.editing = false;
                UI.state.otcBoard = [];            // per-currency board — never show the leaving currency's LPs
                AX.maker.loadConfig(function () { var st = AX.maker._state(); UI.state.makerCfg = st.cfg; UI.state.makerManual = st.manual; UI.render(); refreshBalances(); refreshEthBalances(); refreshBook(); refreshOtc(); });
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
            var bmin = (bestMaker.pairs.USDT && bestMaker.pairs.USDT.min) || 0;   // a sub-min single SELL would lock then be
            if (want <= bestCap + EPS && !(bmin > 0 && want < bmin - 1e-6)) { reviewSingle(bestMaker, amtStr, bestPrice, bestCap); return; }   // declined on-chain → route below-best-min amounts to the sweep planner, which skips the best maker + fills a deeper/lower-min one (or reports below-min)
            var plan = SP.buildSweepPlan(state.book, true, amtStr, 0, myId());
            if (!plan.legs.length) { toast(sweepEmptyMsg(plan)); return; }
            reviewSweep(plan); return;
        }
        // BUY: mxUSDT-target-driven with slippage; the whole spend must fit the USDT balance.
        var bplan = SP.buildSweepPlan(state.book, false, amtStr, buySlippage(), myId());
        if (!bplan.legs.length) { toast(sweepEmptyMsg(bplan)); return; }
        // FAIL CLOSED on an unknown balance: a failed ERC20 read shows '—', and Number('—') is NaN — every
        // comparison against NaN is false, so a bare `total > Number(bals.usdt)` would WAVE THE SPEND THROUGH
        // exactly when we cannot see the balance. Never let an unreadable balance read as "enough".
        var haveUsdt = Number(state.bals.usdt);
        if (!isFinite(haveUsdt)) {
            toast('Can’t read your USDT balance right now — tap Refresh on the Wallet tab, then try again.'); return;
        }
        if (bplan.totalUsdt > haveUsdt + EPS) {
            toast('Need ≈ ' + trimSig(bplan.totalUsdt) + ' USDT for ' + FMT.abbrev(bplan.filledMinima) + ' ' + ccy() + ' — you have ' + trimSig(haveUsdt) + '.'); return;
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
            UI.state.makerCfg = cfg; UI.state.makerManual = manual;
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

    // ---------- OTC ----------
    function refreshOtc() {
        AX.otc.scanBoard(function (e, offers) { if (!e) { UI.state.otcBoard = offers || []; UI.render(); } });
        AX.otc.scanChat(function () { refreshDeals(); });
    }
    function refreshDeals() {
        AX.otc.allDeals(function (e, deals) { if (!e) { UI.state.otcDeals = (deals || []).filter(function (d) { return d.status !== 'EXPIRED' && d.status !== 'REJECTED' && d.status !== 'COMPLETE'; }); UI.render(); } });
    }
    function onOtcGoLive(sell, buy) {
        AX.otc.setMyOffer(true, Number(sell) || 0, Number(buy) || 0);
        AX.otc.publishOffer(function (err) { UI.setStatus(err ? ('OTC publish failed: ' + err.message) : '✓ Availability published.'); });
    }
    function onOtcWithdraw() { AX.otc.setMyOffer(false, 0, 0); AX.otc.publishOffer(function () { UI.setStatus('OTC availability withdrawn.'); }); }
    function onOtcPropose(lp, side, amount, price) {
        AX.otc.propose(lp, side, amount, price, function (err) { UI.setStatus(err ? ('Propose failed: ' + err.message) : '✓ Deal proposed — waiting on the LP.'); refreshDeals(); });
    }
    function onOtcAccept(d) { AX.otc.accept(d, function (err) { UI.setStatus(err ? err.message : '✓ Deal accepted.'); refreshDeals(); }); }
    function onOtcCounter(d, amount, price) { AX.otc.counter(d, amount, price, function (err) { UI.setStatus(err ? err.message : '✓ Counter sent.'); refreshDeals(); }); }
    function onOtcReject(d) { AX.otc.reject(d, function () { UI.setStatus('Deal rejected.'); refreshDeals(); }); }

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
