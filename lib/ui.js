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
        bals: { minima: '0', usdt: '0', eth: '0' }, swaps: [], oracle: '', status: '', paired: false, modal: null
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
        var price = S.sell ? q.bestBid : q.bestAsk;
        var cap = S.sell ? q.bidCap : q.askCap;
        var recv = AX.fmt.quoteOut(S.amount, price, S.sell);
        wrap.appendChild(el('div', { class: 'card' }, [
            el('div', { class: 'label', text: 'YOU SEND' }),
            el('div', { class: 'amtrow' }, [coinChip(S.sell), amtInput(false)]),
            el('div', { class: 'flip' }, [el('div', { class: 'ln' }), el('button', { class: 'btn-flip', text: '⇅', onclick: function () { S.sell = !S.sell; recompute(); } }), el('div', { class: 'ln' })]),
            el('div', { class: 'label', text: 'YOU RECEIVE (estimate)' }),
            el('div', { class: 'amtrow' }, [coinChip(!S.sell), el('div', { class: 'amt recv mono', text: recv || '0.00' })]),
            el('div', { class: 'bestline', text: 'Best price ' + AX.fmt.px(price) + ' USDT/' + ccy() + '  ·  up to ~' + AX.fmt.abbrev(cap) + ' at best' + (S.sell ? '' : '  ·  ETH gas per part') }),
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
    function amtInput(recv) {
        var i = el('input', { class: 'amt mono', inputmode: 'decimal', placeholder: '0.00', value: S.amount });
        i.addEventListener('input', function () { S.amount = i.value.replace(/[^0-9.]/g, ''); softUpdate(); });
        return i;
    }
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
        wrap.appendChild(el('div', { style: 'display:flex;gap:8px' }, [
            el('button', { class: 'btn', style: 'flex:1', text: 'Edit my order', onclick: function () { AX.ui.pending(); } }),
            el('button', { class: 'cta', style: 'flex:1;margin-top:0', text: 'Publish', onclick: function () { AX.ui.pending(); } })
        ]));
        return wrap;
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

    // ---- OTC (shell; negotiation in Phase 6) ----
    function otcTab() {
        return el('div', {}, [
            el('div', { class: 'empty', style: 'margin-top:0', text: 'Negotiate a custom size + price directly with a liquidity provider, then settle as a trustless HTLC swap.' }),
            el('div', { class: 'label', style: 'margin-top:14px', text: 'LIQUIDITY PROVIDERS' }),
            el('div', { class: 'empty', text: 'No OTC LPs online right now.' })
        ]);
    }

    // ---- helpers ----
    function tok(t) { return TR.labelForToken(t); }
    function gt(v) { return parseFloat(v) > 0; }
    function activeSwap() { for (var i = 0; i < (S.swaps || []).length; i++) if (!isTerminal(S.swaps[i])) return S.swaps[i]; return null; }
    function isTerminal(sw) { return sw.status === 'COMPLETE' || sw.status === 'REFUNDED' || sw.status === 'ERROR'; }

    function recompute() { S.quote = B.bestMakers(S.book, myId()); render(); }
    function softUpdate() { S.quote = B.bestMakers(S.book, myId()); /* re-render only the swap card body in Phase 3; full render for now */ render(); }
    function setTab(id) { S.tab = id; render(); if ((id === 'swap' || id === 'market') && AX.ui.onEnterBookTab) AX.ui.onEnterBookTab(); }
    function toggleTheme() { AX.ui.dark = !AX.ui.dark; document.documentElement.setAttribute('data-theme', AX.ui.dark ? 'dark' : 'light'); AX.ui.onThemeSaved && AX.ui.onThemeSaved(AX.ui.dark); render(); }
    function switchCurrency() { if (AX.ui.onSwitchCurrency) AX.ui.onSwitchCurrency(TR.other()); }

    AX.ui = {
        state: S, dark: true, slip: 4.2, version: '0.0.1', block: 0,
        el: el, render: render, setState: function (patch) { for (var k in patch) S[k] = patch[k]; recompute(); },
        dialog: dialog, closeDialog: closeDialog, setStatus: setStatus,
        pending: function () { AX.ui.toast && AX.ui.toast('Coming in a later phase'); }
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
