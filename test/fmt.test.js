/* Display formatting (fmt): price sig-figs, size abbrev, shorten, quote-out (sell=×price, buy=÷price). */
(function () {
    var fmt = AX.fmt;
    T.eq('px 6 sig-figs strip zeros', fmt.px(0.99), '0.99');
    T.eq('px trims', fmt.px(1.010000), '1.01');
    T.eq('px zero', fmt.px(0), '0');
    T.eq('abbrev small', fmt.abbrev(30), '30');
    T.eq('abbrev K', fmt.abbrev(12000), '12K');
    T.eq('abbrev M', fmt.abbrev(2500000), '2.5M');
    T.eq('shorten id', fmt.shorten('0xDE6AB35C589E110903ED3E24ED48526318BDCF5CEF03A81571C7BF5669851F07'), '0xDE6AB3…851F07');
    T.eq('shorten short passthrough', fmt.shorten('0xABCD'), '0xABCD');
    // sell 4.95 mxUSDT at bid 0.99 → 4.9005 USDT (floor 6dp)
    T.eq('quoteOut sell', fmt.quoteOut('4.95', 0.99, true), '4.9005');
    // buy: 5 USDT at ask 1.01 → 4.950495 mxUSDT
    T.eq('quoteOut buy', fmt.quoteOut('5', 1.01, false), '4.950495');
    T.eq('quoteOut empty on zero', fmt.quoteOut('0', 1, true), '');
    T.eq('quoteOut empty on bad', fmt.quoteOut('x', 1, true), '');
})();
