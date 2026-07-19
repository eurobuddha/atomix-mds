/**
 * ui — the AtomiX MiniDapp UI (browser), a pixel-parity port of native MainActivity's programmatic UI to HTML/CSS.
 * Phase 2: renders the shell + all 5 tabs from live read data (order book, balances, activity). Write actions
 * (take/publish/OTC) are wired in Phases 3/5/6 — their controls render now and call AX.ui.pending() until then.
 * Requires AX.trading, AX.order, AX.book, AX.fmt (formatting). Attaches to AX.ui.
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    var TR = AX.trading, O = AX.order, B = AX.book;

    // ---- tiny DOM builder ----
    function el(tag, attrs, kids) {
        var e = document.createElement(tag);
        if (attrs) for (var k in attrs) {
            if (k === 'class') e.className = attrs[k];
            else if (k === 'text') e.textContent = attrs[k];
            else if (k === 'html') e.innerHTML = attrs[k];
            else if (k.indexOf('on') === 0) e.addEventListener(k.slice(2), attrs[k]);
            else e.setAttribute(k, attrs[k]);
        }
        if (kids) for (var i = 0; i < kids.length; i++) if (kids[i] != null) e.appendChild(typeof kids[i] === 'string' ? document.createTextNode(kids[i]) : kids[i]);
        return e;
    }

    // ---- app state ----
    var S = {
        ctx: null, tab: 'swap', sell: true, amount: '', book: {}, quote: null,
        bals: { minima: '0', usdt: '0', eth: '0' }, swaps: [], oracle: '', status: '', paired: false, modal: null,
        editing: false, makerCfg: null, otcBoard: [], otcDeals: [], otcProposing: null, otcCountering: null
    };
    var TABS = [
        { id: 'swap', label: 'Swap', ico: 'M7 7l4-4 4 4M11 3v12M17 17l-4 4-4-4M13 21V9' },
        { id: 'wallet', label: 'Wallet', ico: 'M3 7h15a2 2 0 012 2v7a2 2 0 01-2 2H4a1 1 0 01-1-1V7zM17 12h2' },
        { id: 'activity', label: 'Activity', ico: 'M3 12h4l3 8 4-16 3 8h4' },
        { id: 'market', label: 'Market', ico: 'M5 20V10M12 20V4M19 20v-7' },
        { id: 'otc', label: 'OTC', ico: 'M7 8h13l-3-3M17 16H4l3 3' }
    ];

    function ccy() { return TR.active().coinLabel; }
    function myId() { return S.ctx && S.ctx.identities[TR.active().key].publicId(); }

    // ---- top-level render ----
    function render() {
        document.documentElement.setAttribute('data-ccy', TR.active().key === 'minima' ? 'minima' : 'mxusdt');
        var app = el('div', { id: 'app' }, [
            banner(), el('div', { id: 'scroll' }, [header(), tab()]), tabbar()
        ]);
        var root = document.getElementById('root');
        root.innerHTML = ''; root.appendChild(app);
        if (S.modal) root.appendChild(modalEl(S.modal));   // survive poll-driven re-renders while a dialog is open
    }

    // ---- modal dialog (review/confirm) — an overlay re-appended on every render so a background poll can't wipe it ----
    function modalEl(opts) {
        var lines = (opts.lines || []).map(function (l) { return el('div', { class: 'dlgline ' + (l.cls || ''), text: l.text }); });
        var btns = [el('button', { class: 'pill', text: opts.cancelText || 'Cancel', onclick: closeDialog })];
        if (opts.onConfirm) btns.push(el('button', { class: 'cta', style: 'margin-top:0;flex:1', text: opts.confirmText || 'Confirm',
            onclick: function () { var f = opts.onConfirm; closeDialog(); f(); } }));
        return el('div', { class: 'modal-ov', onclick: function (e) { if (e.target && e.target.className === 'modal-ov') closeDialog(); } }, [
            el('div', { class: 'modal-card' }, [el('div', { class: 'modal-title', text: opts.title })].concat(lines).concat([el('div', { class: 'modal-btns' }, btns)]))
        ]);
    }
    function dialog(opts) { S.modal = opts; render(); }
    function closeDialog() { S.modal = null; render(); }
    function setStatus(msg) { S.status = msg; render(); }

    function banner() {
        var b = el('div', { id: 'pairbanner', text: 'Connecting to your node — enable AtomiX in Minima Core → Apps.' });
        if (!S.paired) b.className = 'show';
        return b;
    }

    function header() {
        return el('div', {}, [
            el('div', { class: 'hdr' }, [
                el('div', { class: 'brand', text: 'AtomiX' }),
                el('button', { class: 'pill accent', text: ccy(), onclick: switchCurrency }),
                el('button', { class: 'pill', text: AX.ui.dark ? '☾' : '☀', onclick: toggleTheme }),
                el('span', { class: 'pill accent' }, [el('span', { class: 'dot' }), document.createTextNode('Mainnet')])
            ]),
            el('div', { class: 'subline', text: 'v' + AX.ui.version + '  ·  ' + (AX.ui.block ? 'block ' + AX.ui.block + '  ·  ' : '') + 'real funds' })
        ]);
    }

    function tabbar() {
        return el('div', { id: 'tabbar' }, TABS.map(function (t) {
            return el('div', { class: 'tab' + (S.tab === t.id ? ' sel' : ''), onclick: function () { setTab(t.id); } }, [
                el('div', { class: 'ico-wrap', html: '<svg viewBox="0 0 24 24"><path d="' + t.ico + '"/></svg>' }),
                el('div', { text: t.label })
            ]);
        }));
    }

    function tab() {
        if (S.tab === 'swap') return swapTab();
        if (S.tab === 'market') return marketTab();
        if (S.tab === 'wallet') return walletTab();
        if (S.tab === 'activity') return activityTab();
        return otcTab();
    }

    // ---- SWAP ----
    function swapTab() {
        var q = S.quote;
        var have = q && (S.sell ? q.bidMaker : q.askMaker);
        var wrap = el('div', {}, [
            el('div', { class: 'hdr' }, [el('div', { class: 'brand', text: 'Swap ' + ccy() + ' ⇄ USDT', style: 'font-size:18px' })]),
            el('div', { class: 'subline', text: "Enter an amount — see exactly what you'll get at the best price." }),
            el('div', { class: 'seg' }, [
                el('button', { class: 'segbtn' + (S.sell ? ' on' : ''), text: 'Sell ' + ccy(), onclick: function () { S.sell = true; recompute(); } }),
                el('button', { class: 'segbtn' + (!S.sell ? ' on' : ''), text: 'Buy ' + ccy(), onclick: function () { S.sell = false; recompute(); } })
            ])
        ]);
        if (!have) {
            wrap.appendChild(el('div', { class: 'card' }, [
                el('div', { style: 'font-weight:700', text: 'No one is quoting a ' + (S.sell ? 'buy' : 'sell') + ' price right now.' }),
                el('div', { class: 'empty', text: 'Check back soon, or open Market to place your own order and wait for a match.' }),
                el('button', { class: 'pill', text: 'Open Market', style: 'margin-top:10px', onclick: function () { setTab('market'); } })
            ]));
            wrap.appendChild(stages());
            return wrap;
        }
        // ---- faithful bidirectional dual-amount card (native parity): the ccy (mxUSDT) field is the canonical
        //      S.amount; typing EITHER field updates the other in place (no re-render → the edited field keeps focus). ----
        var price = S.sell ? q.bestBid : q.bestAsk;
        var cap = S.sell ? q.bidCap : q.askCap;
        var depth = AX.swapplan.sweepDepthMinima(S.book, S.sell, myId(), S.sell ? 0 : (AX.ui.slip / 100));
        var ccyIn = bidiInput(S.amount);                                   // holds the mxUSDT (ccy) amount
        var usdtIn = bidiInput(AX.swapplan.computeUsdt(S.amount, price) || '');   // the USDT estimate (floor)
        ccyIn.addEventListener('input', function () {
            S.amount = clean(ccyIn.value); if (ccyIn.value !== S.amount) ccyIn.value = S.amount;
            usdtIn.value = AX.swapplan.computeUsdt(S.amount, price) || '';   // sibling only — never render mid-edit
        });
        usdtIn.addEventListener('input', function () {
            var u = clean(usdtIn.value); if (usdtIn.value !== u) usdtIn.value = u;
            S.amount = AX.swapplan.computeMinima(u, price) || ''; ccyIn.value = S.amount;
        });
        var blurRender = function () { setTimeout(function () { if (document.activeElement !== ccyIn && document.activeElement !== usdtIn) render(); }, 250); };
        ccyIn.addEventListener('blur', blurRender); usdtIn.addEventListener('blur', blurRender);
        var sendRow = amtField('YOU SEND', S.sell ? coinChip(true) : coinChip(false), S.sell ? ccyIn : usdtIn);
        var recvRow = amtField('YOU RECEIVE (estimate)', S.sell ? coinChip(false) : coinChip(true), S.sell ? usdtIn : ccyIn);
        wrap.appendChild(el('div', { class: 'card' }, [
            sendRow,
            el('div', { class: 'flip' }, [el('div', { class: 'ln' }), el('button', { class: 'btn-flip', text: '⇅', onclick: function () { S.sell = !S.sell; recompute(); } }), el('div', { class: 'ln' })]),
            recvRow,
            el('div', { class: 'bestline', text: 'Best price ' + AX.fmt.px(price) + ' USDT/' + ccy() + '  ·  up to ~' + AX.fmt.abbrev(cap) + ' at best'
                + (depth > cap + 1e-9 ? ', ~' + AX.fmt.abbrev(depth) + ' across the book' : '') + (S.sell ? '' : '  ·  ETH gas per part') }),
            S.sell ? null : slippageRow(),
            el('button', { class: 'cta', text: 'Review swap', onclick: function () { AX.ui.onReview && AX.ui.onReview(S); } })
        ]));
        wrap.appendChild(stages());
        if (S.status) wrap.appendChild(el('div', { class: 'statusline' + (S.status.charAt(0) === '✓' ? ' ok' : ''), text: S.status }));
        return wrap;
    }

    function coinChip(isCcy) {
        var lab = isCcy ? ccy() : 'USDT';
        var disc = el('div', { class: 'disc' + (isCcy ? '' : ' usdt'), text: isCcy ? 'M' : '$' });
        var avail = isCcy ? S.bals.minima : S.bals.usdt;
        return el('div', { class: 'coinchip' }, [disc, el('div', {}, [el('div', { class: 'tick', text: lab }), el('div', { class: 'avail', text: 'avail ' + avail })])]);
    }
    /** A large mono decimal input (native monoBold 26). Wiring is done by the caller (bidirectional conversion). */
    function bidiInput(val) { return el('input', { class: 'amt mono', inputmode: 'decimal', placeholder: '0.00', value: val || '' }); }
    /** A labelled amount row: [label] then [coin chip + amount input]. */
    function amtField(label, chip, input) { return el('div', {}, [el('div', { class: 'label', text: label }), el('div', { class: 'amtrow' }, [chip, input])]); }
    function clean(v) { return String(v).replace(/[^0-9.]/g, ''); }
    function slippageRow() {
        return el('div', { class: 'sliprow' }, [
            el('span', { class: 'label', text: 'Max slippage', style: 'text-transform:none' }),
            el('button', { class: 'pill' + (AX.ui.slip === 2 ? ' on' : ''), text: '2%', onclick: function () { AX.ui.slip = 2; softUpdate(); } }),
            el('button', { class: 'pill' + (AX.ui.slip === 4.2 ? ' on' : ''), text: '4.2%', onclick: function () { AX.ui.slip = 4.2; softUpdate(); } }),
            el('button', { class: 'pill', text: 'Custom', onclick: function () { AX.ui.pending(); } })
        ]);
    }

    function stages() {
        var rows = [];
        rows.push(stageRow(S.paired ? 'done' : 'warn', 'Node connected'));
        if (S.sell) rows.push(stageRow(gt(S.bals.minima) ? 'done' : 'pending', ccy() + ' ready to sell'));
        else { rows.push(stageRow(gt(S.bals.usdt) ? 'done' : 'pending', 'USDT ready to spend')); rows.push(stageRow(gt(S.bals.eth) ? 'done' : 'pending', 'ETH for gas')); }
        var sw = activeSwap();
        if (sw) {
            rows.push(el('div', { class: 'mono', style: 'font-size:12px;color:var(--dim2);padding:4px 0', text: sw.sellamount + ' ' + tok(sw.selltoken) + ' → ' + sw.buyamount + ' ' + tok(sw.buytoken) + ' · ' + sw.role.toLowerCase() }));
            rows.push(stageRow(legDone(sw, 1), 'Locked your ' + sw.sellamount + ' ' + tok(sw.selltoken)));
            rows.push(stageRow(legDone(sw, 2), 'Counterparty locks their side'));
            rows.push(stageRow(legDone(sw, 3), 'Claim your ' + sw.buyamount + ' ' + tok(sw.buytoken)));
            rows.push(stageRow(legDone(sw, 4), 'Swap complete'));
        } else rows.push(stageRow('pending', 'Enter an amount and tap Review to begin'));
        return el('div', {}, [el('div', { class: 'label', style: 'margin-top:16px', text: 'YOUR SWAP' }), el('div', { class: 'stages' }, rows)]);
    }
    function stageRow(state, text) { return el('div', { class: 'stage ' + state }, [el('span', { class: 'sdot' }), el('span', { text: text })]); }
    function legDone(sw, n) {
        var st = sw.status;
        if (st === 'COMPLETE') return 'done';
        if (st === 'REFUNDED') return n === 1 ? 'warn' : 'pending';
        if (n === 1) return 'done';
        if (n === 2) return (st === 'LOCKED' || st === 'CLAIMING') ? 'active' : 'pending';
        if (n === 3) return st === 'CLAIMING' ? 'active' : 'pending';
        return 'pending';
    }

    // ---- MARKET (order book) ----
    function marketTab() {
        var wrap = el('div', {}, [
            el('div', { class: 'empty', style: 'margin-top:0', text: 'The live order book. Tap a price to trade, or publish your own offer.' })
        ]);
        if (S.oracle) wrap.appendChild(el('div', { class: 'mono', style: 'font-size:11.5px;color:var(--dim);margin-top:6px', text: S.oracle }));
        var n = Object.keys(S.book).length;
        wrap.appendChild(el('div', { class: 'hdr', style: 'margin-top:12px' }, [
            el('div', { class: 'brand', style: 'font-size:16px', text: 'Order book  ·  ' + n + ' live' }),
            el('button', { class: 'pill', text: 'Refresh', onclick: function () { AX.ui.onRefreshBook && AX.ui.onRefreshBook(); } })
        ]));
        var bids = B.aggSide(S.book, true, null), asks = B.aggSide(S.book, false, null);
        if (!bids.length && !asks.length) { wrap.appendChild(el('div', { class: 'empty', text: 'No live orders yet. Publish one, or wait for a counterparty.' })); }
        else {
            var bestBid = bids.length ? bids[0].level.p : 0, bestAsk = asks.length ? asks[0].level.p : 0;
            if (bestBid && bestAsk) wrap.appendChild(el('div', { class: 'mono', style: 'font-size:11px;color:var(--dim2)', text: 'spread ' + AX.fmt.px(bestAsk - bestBid) + ' USDT  ·  USDT per ' + ccy() + ', size in ' + ccy() }));
            wrap.appendChild(el('div', { class: 'legend' }, [el('span', { class: 'sell', text: 'SELL ' + ccy() + ' (bid)' }), el('span', { class: 'buy', text: 'BUY ' + ccy() + ' (ask)' })]));
            var rows = Math.min(Math.max(bids.length, asks.length), 12);
            for (var i = 0; i < rows; i++) wrap.appendChild(depthRow(bids[i], asks[i], i === 0));
        }
        wrap.appendChild(el('div', { class: 'spacer' }));
        if (S.editing) { wrap.appendChild(orderEditor()); return wrap; }
        wrap.appendChild(el('div', { style: 'display:flex;gap:8px' }, [
            el('button', { class: 'btn', style: 'flex:1', text: 'Edit my order', onclick: function () { S.editing = true; render(); } }),
            el('button', { class: 'cta', style: 'flex:1;margin-top:0', text: 'Publish', onclick: function () { AX.ui.onPublish && AX.ui.onPublish(); } })
        ]));
        return wrap;
    }

    // ---- maker order editor (auto-MM peg ladder or a manual single level) ----
    function editInput(id, val, ph) { var i = el('input', { class: 'amt mono', inputmode: 'decimal', placeholder: ph || '0', value: (val == null ? '' : String(val)), style: 'font-size:16px;text-align:right' }); i.id = id; return i; }
    function editRow(label, input) { return el('div', { class: 'amtrow', style: 'justify-content:space-between' }, [el('div', { class: 'label', style: 'text-transform:none', text: label }), input]); }
    function toggle(on, cb) { return el('button', { class: 'pill' + (on ? ' on' : ''), text: on ? 'On' : 'Off', onclick: cb }); }
    function orderEditor() {
        var c = S.makerCfg || (S.makerCfg = {});
        var peg = c.pegEnable !== false;   // default auto-price on
        var box = el('div', { class: 'card' }, [
            el('div', { class: 'label', text: 'YOUR MARKET · ' + ccy() + ' ⇄ USDT' }),
            editRow('Auto-price (peg to ' + (TR.active().pricingParity ? 'parity' : 'MEXC') + ')', toggle(peg, function () { c.pegEnable = !peg; render(); }))
        ]);
        if (peg) {
            box.appendChild(editRow('Spread step %', editInput('mk_step', c.step != null ? c.step : 1)));
            box.appendChild(editRow('Size per level (' + ccy() + ')', editInput('mk_size', c.size != null ? c.size : '')));
            box.appendChild(editRow('Levels each side (1–6)', editInput('mk_levels', c.levels != null ? c.levels : 1)));
            box.appendChild(editRow('Skew % (± mid)', editInput('mk_bias', c.bias != null ? c.bias : 0)));
            box.appendChild(editRow('Reprice when moved %', editInput('mk_reprice', c.reprice != null ? c.reprice : 1)));
        } else {
            box.appendChild(editRow('Bid (USDT/' + ccy() + ')', editInput('mk_bid', c.bid != null ? c.bid : '')));
            box.appendChild(editRow('Ask (USDT/' + ccy() + ')', editInput('mk_ask', c.ask != null ? c.ask : '')));
            box.appendChild(editRow('Size (' + ccy() + ')', editInput('mk_msize', c.msize != null ? c.msize : '')));
        }
        box.appendChild(editRow('Min trade (' + ccy() + ')', editInput('mk_min', c.min != null ? c.min : '')));
        box.appendChild(el('button', { class: 'cta', text: 'Save & publish', onclick: function () { saveEditor(peg); } }));
        box.appendChild(el('div', { style: 'display:flex;gap:8px;margin-top:8px' }, [
            el('button', { class: 'pill', style: 'flex:1;justify-content:center', text: 'Withdraw market', onclick: function () { AX.ui.onWithdraw && AX.ui.onWithdraw(); S.editing = false; } }),
            el('button', { class: 'pill', style: 'flex:1;justify-content:center', text: 'Cancel', onclick: function () { S.editing = false; render(); } })
        ]));
        return box;
    }
    function numVal(id) { var e = document.getElementById(id); return e ? e.value.replace(/[^0-9.\-]/g, '') : ''; }
    function saveEditor(peg) {
        var cfg = { pegEnable: peg, min: numVal('mk_min') };
        var manual = { bids: [], asks: [] };
        if (peg) {
            cfg.step = numVal('mk_step'); cfg.size = numVal('mk_size'); cfg.levels = numVal('mk_levels');
            cfg.bias = numVal('mk_bias'); cfg.reprice = numVal('mk_reprice');
        } else {
            var bid = numVal('mk_bid'), ask = numVal('mk_ask'), sz = numVal('mk_msize');
            if (Number(bid) > 0 && Number(sz) > 0) manual.bids.push({ p: Number(bid), a: Number(sz) });
            if (Number(ask) > 0 && Number(sz) > 0) manual.asks.push({ p: Number(ask), a: Number(sz) });
        }
        S.makerCfg = cfg; S.editing = false;
        if (AX.ui.onSaveOrder) AX.ui.onSaveOrder(cfg, manual);
    }
    function depthRow(bid, ask, best) {
        function half(row, isBid) {
            if (!row) return el('div', { class: 'half' + (isBid ? ' bid' : '') }, [el('span', { class: 'sz', text: '—' })]);
            var cap = B.levelCap(row.maker, row.level, isBid);
            var mine = B.isMine(row.maker, myId());
            return el('div', { class: 'half' + (isBid ? ' bid' : ''), onclick: function () { if (!mine && cap > 0) AX.ui.onTake && AX.ui.onTake(row.maker, isBid); } }, [
                el('span', { class: 'mono px ' + (isBid ? 'bidpx' : 'askpx'), text: AX.fmt.px(row.level.p) }),
                document.createTextNode(' '),
                el('span', { class: 'sz', text: AX.fmt.abbrev(row.level.a) }),
                el('div', { class: 'tag' + (mine ? ' you' : ''), text: mine ? 'you' : AX.fmt.shorten(row.maker.signerPk) })
            ]);
        }
        return el('div', { class: 'depth' + (best ? ' best' : '') }, [half(bid, true), el('span', { class: 'divider', text: '│' }), half(ask, false)]);
    }

    // ---- WALLET ----
    function walletTab() {
        return el('div', {}, [
            walletCard('Minima · available to swap', S.bals.minima + ' ' + ccy(), 'var(--accent)'),
            walletCard('Ethereum · Ethereum', S.bals.eth + ' ETH', 'var(--text)'),
            walletCard('USDT · Ethereum', S.bals.usdt + ' USDT', 'var(--text)'),
            el('div', { style: 'display:flex;gap:8px;margin-top:12px' }, [
                el('button', { class: 'pill', text: '↻  Refresh', onclick: function () { AX.ui.onRefreshBal && AX.ui.onRefreshBal(); } }),
                el('button', { class: 'pill', text: '⤓  Fund / QR', onclick: function () { AX.ui.pending(); } }),
                el('button', { class: 'pill', text: '🔑  Export key', onclick: function () { AX.ui.pending(); } })
            ])
        ]);
    }
    function walletCard(title, val, color) {
        return el('div', { class: 'card tight', style: 'border-radius:16px' }, [
            el('div', { class: 'label', style: 'text-transform:none;letter-spacing:0', text: title }),
            el('div', { class: 'bigval', style: 'color:' + color + ';margin-top:4px', text: val })
        ]);
    }

    // ---- ACTIVITY ----
    function activityTab() {
        var list = S.swaps || [];
        var wrap = el('div', {}, [el('div', { class: 'hdr' }, [el('div', { class: 'brand', style: 'font-size:16px', text: 'Your swaps' })])]);
        if (!list.length) { wrap.appendChild(el('div', { class: 'empty', text: 'No swaps yet — your completed and refunded swaps will appear here.' })); return wrap; }
        list.forEach(function (sw) {
            wrap.appendChild(el('div', { class: 'card tight' }, [
                el('div', { style: 'display:flex;align-items:center;gap:8px' }, [
                    el('div', { class: 'mono', style: 'flex:1;font-size:14px', text: sw.sellamount + ' ' + tok(sw.selltoken) + ' → ' + sw.buyamount + ' ' + tok(sw.buytoken) }),
                    el('span', { class: 'status ' + sw.status.toLowerCase(), text: statusLabel(sw.status) })
                ]),
                el('div', { class: 'statusline', text: statusDetail(sw) })
            ]));
        });
        return wrap;
    }
    function statusLabel(s) { return { STARTED: 'waiting', LOCKED: 'locked', CLAIMING: 'claiming', COMPLETE: 'complete', REFUNDED: 'refunded', ERROR: 'error' }[s] || s.toLowerCase(); }
    function statusDetail(sw) {
        if (sw.status === 'COMPLETE') return 'Done — received ' + sw.buyamount + ' ' + tok(sw.buytoken) + '.';
        if (sw.status === 'REFUNDED') return 'Timed out — your ' + sw.sellamount + ' ' + tok(sw.selltoken) + ' was refunded.';
        if (sw.status === 'CLAIMING') return 'Counterparty locked — claiming your ' + sw.buyamount + ' ' + tok(sw.buytoken) + ' now.';
        return 'Locked your ' + sw.sellamount + ' ' + tok(sw.selltoken) + ' — waiting for the counterparty to lock their side.';
    }

    // ---- OTC (negotiated peer-to-peer) ----
    function otcTab() {
        var wrap = el('div', {}, [el('div', { class: 'empty', style: 'margin-top:0', text: 'Negotiate a custom size + price directly with a liquidity provider, then settle as a trustless HTLC swap.' })]);
        // my availability
        wrap.appendChild(el('div', { class: 'card' }, [
            el('div', { class: 'label', text: 'YOUR AVAILABILITY (' + ccy() + ')' }),
            editRow('Max to SELL', editInput('otc_sell', '', ccy())),
            editRow('Max to BUY', editInput('otc_buy', '', ccy())),
            el('div', { style: 'display:flex;gap:8px;margin-top:8px' }, [
                el('button', { class: 'cta', style: 'flex:1;margin-top:0', text: 'Go live', onclick: function () { AX.ui.onOtcGoLive && AX.ui.onOtcGoLive(numVal('otc_sell'), numVal('otc_buy')); } }),
                el('button', { class: 'pill', style: 'flex:1;justify-content:center', text: 'Withdraw', onclick: function () { AX.ui.onOtcWithdraw && AX.ui.onOtcWithdraw(); } })
            ])
        ]));
        // active deals
        var deals = S.otcDeals || [];
        if (deals.length) {
            wrap.appendChild(el('div', { class: 'label', style: 'margin-top:14px', text: 'YOUR DEALS' }));
            deals.forEach(function (d) { wrap.appendChild(dealCard(d)); });
        }
        // LP board
        wrap.appendChild(el('div', { class: 'label', style: 'margin-top:14px', text: 'LIQUIDITY PROVIDERS' }));
        var board = S.otcBoard || [];
        if (!board.length) wrap.appendChild(el('div', { class: 'empty', text: 'No OTC LPs online right now.' }));
        board.forEach(function (lp) { wrap.appendChild(lpCard(lp)); });
        if (S.otcProposing) wrap.appendChild(proposePanel(S.otcProposing));
        if (S.otcCountering) wrap.appendChild(counterPanel(S.otcCountering));
        if (S.status) wrap.appendChild(el('div', { class: 'statusline' + (S.status.charAt(0) === '✓' ? ' ok' : ''), text: S.status }));
        return wrap;
    }
    function lpCard(lp) {
        var lines = [];
        if (lp.sellSize > 0) lines.push('sells up to ' + AX.fmt.abbrev(lp.sellSize) + ' ' + ccy());
        if (lp.buySize > 0) lines.push('buys up to ' + AX.fmt.abbrev(lp.buySize) + ' ' + ccy());
        return el('div', { class: 'card tight' }, [
            el('div', { style: 'display:flex;align-items:center;gap:8px' }, [
                el('div', { class: 'mono', style: 'flex:1;font-size:13px', text: AX.fmt.shorten(lp.commsPublicId || lp.signerPk) }),
                el('button', { class: 'pill accent', text: 'Trade', onclick: function () { S.otcProposing = lp; S.otcCountering = null; render(); } })
            ]),
            el('div', { class: 'statusline', text: lines.join('  ·  ') || 'no liquidity' })
        ]);
    }
    function dealCard(d) {
        var mine = d.whoseTurn === 'ME', term = d.status === 'AGREED' || d.status === 'EXECUTING';
        var acts = [];
        if (mine && !term) {
            acts.push(el('button', { class: 'pill accent', text: 'Accept', onclick: function () { AX.ui.onOtcAccept && AX.ui.onOtcAccept(d); } }));
            acts.push(el('button', { class: 'pill', text: 'Counter', onclick: function () { S.otcCountering = d; S.otcProposing = null; render(); } }));
            acts.push(el('button', { class: 'pill', text: 'Reject', onclick: function () { AX.ui.onOtcReject && AX.ui.onOtcReject(d); } }));
        }
        return el('div', { class: 'card tight' }, [
            el('div', { style: 'display:flex;align-items:center;gap:8px' }, [
                el('div', { class: 'mono', style: 'flex:1;font-size:13px', text: (d.side === 'SELL' ? 'LP sells ' : 'LP buys ') + d.amount + ' ' + ccy() + ' @ ' + d.price }),
                el('span', { class: 'status ' + (term ? 'complete' : ''), text: d.status.toLowerCase() })
            ]),
            el('div', { class: 'statusline', text: term ? (d.status === 'AGREED' ? 'Agreed — locking legs…' : 'Executing on-chain…') : (mine ? 'Your move.' : 'Waiting on the counterparty.') }),
            acts.length ? el('div', { style: 'display:flex;gap:8px;margin-top:8px' }, acts) : null
        ]);
    }
    function proposePanel(lp) {
        var side = S._otcSide || (lp.sellSize > 0 ? 'SELL' : 'BUY');
        return el('div', { class: 'card' }, [
            el('div', { class: 'label', text: 'PROPOSE TO ' + AX.fmt.shorten(lp.commsPublicId || lp.signerPk) }),
            el('div', { class: 'seg' }, [
                el('button', { class: 'segbtn' + (side === 'SELL' ? ' on' : '') + (lp.sellSize > 0 ? '' : ' off'), text: 'Buy ' + ccy() + ' (LP sells)', onclick: function () { if (lp.sellSize > 0) { S._otcSide = 'SELL'; render(); } } }),
                el('button', { class: 'segbtn' + (side === 'BUY' ? ' on' : '') + (lp.buySize > 0 ? '' : ' off'), text: 'Sell ' + ccy() + ' (LP buys)', onclick: function () { if (lp.buySize > 0) { S._otcSide = 'BUY'; render(); } } })
            ]),
            editRow('Amount (' + ccy() + ')', editInput('otc_amt', '')),
            editRow('Price (USDT/' + ccy() + ')', editInput('otc_px', '')),
            el('div', { style: 'display:flex;gap:8px;margin-top:8px' }, [
                el('button', { class: 'cta', style: 'flex:1;margin-top:0', text: 'Send proposal', onclick: function () { AX.ui.onOtcPropose && AX.ui.onOtcPropose(lp, side, numVal('otc_amt'), numVal('otc_px')); S.otcProposing = null; } }),
                el('button', { class: 'pill', style: 'flex:1;justify-content:center', text: 'Cancel', onclick: function () { S.otcProposing = null; render(); } })
            ])
        ]);
    }
    function counterPanel(d) {
        return el('div', { class: 'card' }, [
            el('div', { class: 'label', text: 'COUNTER — ' + d.side + ' ' + ccy() }),
            editRow('Amount (' + ccy() + ')', editInput('otc_camt', d.amount)),
            editRow('Price (USDT/' + ccy() + ')', editInput('otc_cpx', d.price)),
            el('div', { style: 'display:flex;gap:8px;margin-top:8px' }, [
                el('button', { class: 'cta', style: 'flex:1;margin-top:0', text: 'Send counter', onclick: function () { AX.ui.onOtcCounter && AX.ui.onOtcCounter(d, numVal('otc_camt'), numVal('otc_cpx')); S.otcCountering = null; } }),
                el('button', { class: 'pill', style: 'flex:1;justify-content:center', text: 'Cancel', onclick: function () { S.otcCountering = null; render(); } })
            ])
        ]);
    }

    // ---- helpers ----
    function tok(t) { return TR.labelForToken(t); }
    function gt(v) { return parseFloat(v) > 0; }
    function activeSwap() { for (var i = 0; i < (S.swaps || []).length; i++) if (!isTerminal(S.swaps[i])) return S.swaps[i]; return null; }
    function isTerminal(sw) { return sw.status === 'COMPLETE' || sw.status === 'REFUNDED' || sw.status === 'ERROR'; }

    function recompute() { S.quote = B.bestMakers(S.book, myId()); render(); }
    function softUpdate() { S.quote = B.bestMakers(S.book, myId()); /* re-render only the swap card body in Phase 3; full render for now */ render(); }
    function setTab(id) { S.tab = id; render(); if ((id === 'swap' || id === 'market') && AX.ui.onEnterBookTab) AX.ui.onEnterBookTab(); if (id === 'otc' && AX.ui.onEnterOtc) AX.ui.onEnterOtc(); }
    function toggleTheme() { AX.ui.dark = !AX.ui.dark; document.documentElement.setAttribute('data-theme', AX.ui.dark ? 'dark' : 'light'); AX.ui.onThemeSaved && AX.ui.onThemeSaved(AX.ui.dark); render(); }
    function switchCurrency() { if (AX.ui.onSwitchCurrency) AX.ui.onSwitchCurrency(TR.other()); }

    AX.ui = {
        state: S, dark: true, slip: 4.2, version: '0.1.1', block: 0,
        el: el, render: render, setState: function (patch) { for (var k in patch) S[k] = patch[k]; recompute(); },
        dialog: dialog, closeDialog: closeDialog, setStatus: setStatus,
        pending: function () { AX.ui.toast && AX.ui.toast('Coming in a later phase'); }
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
