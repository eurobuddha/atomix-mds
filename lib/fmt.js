/**
 * fmt — display formatting (port of native fmtPrice/abbrev/Util.shorten). DISPLAY only — the exact-decimal trade
 * amounts (6dp grain) are computed in the engine with the decimal helpers. Attaches to AX.fmt.
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};

    /** price with up to 6 significant figures, trailing zeros stripped. */
    function px(v) {
        v = Number(v); if (!isFinite(v) || v <= 0) return '0';
        var s = v.toPrecision(6);
        if (s.indexOf('.') > -1) s = s.replace(/0+$/, '').replace(/\.$/, '');
        return s;
    }

    /** a size (native abbrev parity): "—" for ≤0; lowercase "k" ≥ 1000; else the number floored to 2dp (<10) or
     *  1dp (≥10), trailing zeros stripped. */
    function abbrev(v) {
        v = Number(v);
        if (!(v > 0)) return '—';
        return v >= 1000 ? (trimNum(v / 1000) + 'k') : trimNum(v);
    }
    function trimNum(v) {
        var dp = v < 10 ? 2 : 1, f = Math.pow(10, dp);
        return (Math.floor(v * f) / f).toString();   // toString strips trailing zeros (5.00→"5", 123.4→"123.4")
    }

    /** short signer/id: 0x + first 6 + … + last 6. */
    function shorten(pk) {
        if (!pk) return '';
        var h = pk.indexOf('0x') === 0 ? pk.slice(2) : pk;
        if (h.length <= 14) return pk;
        return '0x' + h.slice(0, 6) + '…' + h.slice(-6);
    }

    /** the "you receive/pay" estimate: sell mxUSDT → USDT = amount*bid; buy mxUSDT → mxUSDT = usdtAmount/ask. */
    function quoteOut(amount, price, sell) {
        var a = parseFloat(amount); if (!isFinite(a) || a <= 0 || !isFinite(price) || price <= 0) return '';
        var out = sell ? a * price : a / price;
        return trim6(out);
    }
    function trim6(v) {
        var s = (Math.floor(v * 1e6) / 1e6).toString();
        return s;
    }

    AX.fmt = { px: px, abbrev: abbrev, shorten: shorten, quoteOut: quoteOut, trim6: trim6 };
})(typeof globalThis !== 'undefined' ? globalThis : this);
