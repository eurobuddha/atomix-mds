/* ethrpc — sticky endpoint fallback over a mocked MDS.net.POST + hexToBig. */
(function () {
    var R = AX.ethrpc;
    T.eq('hexToBig 0x10', String(R.hexToBig('0x10')), '16');
    T.eq('hexToBig null', String(R.hexToBig(null)), '0');
    T.eq('hexToBig empty 0x', String(R.hexToBig('0x')), '0');
    T.eq('hexToBig big', String(R.hexToBig('0xde0b6b3a7640000')), '1000000000000000000');

    var saved = globalThis.MDS;
    try {
        var hits = [];
        // Primary (publicnode) returns an HTML error page (non-JSON) → must fail over to the next endpoint.
        globalThis.MDS = { net: { POST: function (url, data, cb) {
            hits.push(url);
            if (url.indexOf('publicnode.com') >= 0) return cb({ response: '<html>521 origin down</html>' });
            cb({ response: JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + (0x1000).toString(16) }) });
        } } };
        var rpc = new R.Rpc('https://ethereum-rpc.publicnode.com');
        rpc.blockNumber(function (e, n) {
            T.ok('fallback: no error', !e);
            T.eq('fallback: decoded value', String(n), '4096');
            T.ok('fallback: primary tried first', hits[0].indexOf('publicnode.com') >= 0);
            T.ok('fallback: stuck to the endpoint that answered', rpc.url.indexOf('publicnode.com') < 0);
        });

        // eth error object → surfaced as a failure on that endpoint, then fall through.
        globalThis.MDS = { net: { POST: function (url, data, cb) {
            cb({ response: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'rate limited' } }) });
        } } };
        var rpc2 = new R.Rpc('https://ethereum-rpc.publicnode.com');
        rpc2.blockNumber(function (e, n) {
            T.ok('all-error → error returned', !!e);
            T.ok('error names all-RPC exhaustion', e && /failed on all RPCs/.test(e.message));
        });

        // getContract-style eth_call returns raw hex passthrough.
        globalThis.MDS = { net: { POST: function (url, data, cb) { cb({ response: JSON.stringify({ result: '0xabcd' }) }); } } };
        new R.Rpc('https://eth.drpc.org').ethCall('0xTo', '0xdata', function (e, ret) {
            T.eq('ethCall passthrough', ret, '0xabcd');
        });
    } finally { globalThis.MDS = saved; }
})();
