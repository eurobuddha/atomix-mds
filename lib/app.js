/**
 * app — the browser controller: boots identity, wires the UI's read-refresh handlers to the live node (order book,
 * balances, activity from SQL), and drives the poll cadence. Write actions (take/publish/OTC) land in later phases;
 * this wires the READ layer so the UI renders live. Requires the AX.* stack + AX.ui. Attaches to AX.app.
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};
    var M = AX.mds, TR = AX.trading, B = AX.book, UI = AX.ui, F = AX.flow;

    function start() {
        // theme from kv (default dark)
        AX.boot.init(function (err, ctx) {
            if (err) { UI.state.paired = false; toast('Boot failed: ' + err.message); UI.render(); return; }
            UI.state.ctx = ctx; UI.state.paired = true;
            UI.onRefreshBook = refreshBook; UI.onRefreshBal = refreshBalances; UI.onEnterBookTab = refreshBook;
            UI.onThemeSaved = function (dark) { M.kvSet('theme', dark ? 'dark' : 'light'); };
            UI.onSwitchCurrency = switchCurrency;
            UI.toast = toast;
            M.kvGet('theme', 'dark', function (t) {
                UI.dark = (t !== 'light');
                document.documentElement.setAttribute('data-theme', UI.dark ? 'dark' : 'light');
                UI.render();
                refreshBlock(); refreshBalances(); refreshBook(); refreshSwaps();
                // poll cadence: heavy 90s (balances + book on book tabs), light 30s
                setInterval(function () { refreshBlock(); refreshBalances(); if (UI.state.tab === 'swap' || UI.state.tab === 'market') refreshBook(); refreshSwaps(); }, 90000);
            });
        });
    }

    function refreshBlock() { M.cmdR('block', function (err, r) { if (!err && r) { UI.block = r.block || r; UI.render(); } }); }

    function refreshBook() {
        if (!UI.state.ctx) return;
        B.scan(function (err, book) { if (!err) { UI.state.book = book; UI.setState({ book: book }); } });
    }

    function refreshBalances() {
        M.cmdR('balance tokenid:' + TR.active().tokenId, function (err, r) {
            if (!err && r && r[0]) UI.state.bals.minima = trim(r[0].sendable);
            // ETH + USDT balances come via the ETH RPC layer in Phase 3; show the derived ETH address balance later.
            UI.render();
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
        // Phase 2: flip currency + re-theme + re-read. The tombstone-on-switch + per-currency market memory land
        // with the maker path (Phase 5); here we quiesce reads and re-scan the target book.
        M.kvSet('trading_currency', target.key, function () {
            TR.setActive(target);
            UI.state.book = {}; UI.state.quote = null;
            UI.render(); refreshBalances(); refreshBook();
        });
    }

    function toast(msg) {
        var t = document.getElementById('toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
        t.textContent = msg; t.className = 'show';
        clearTimeout(toast._t); toast._t = setTimeout(function () { t.className = ''; }, 2200);
    }

    function trim(v) { var n = parseFloat(v); return isFinite(n) ? (Math.round(n * 1e6) / 1e6).toString() : '0'; }

    AX.app = { start: start };
})(typeof globalThis !== 'undefined' ? globalThis : this);
