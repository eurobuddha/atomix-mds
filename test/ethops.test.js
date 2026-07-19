/* ethops — read ops build the right calldata + decode; write ops route through ethtx.send with the right tx. */
(function () {
    var EO = AX.ethops, AB = AX.abi, pad = AX.abi.pad64;

    // Fake RPC capturing eth_call, plus a spy over ethtx.send for the write ops.
    var lastCall = null;
    var rpc = { ethCall: function (to, data, cb) { lastCall = { to: to, data: data }; cb(null, rpc._ret || '0x'); } };
    var o = EO.make(rpc, '0x' + '11'.repeat(32), '0x1111111111111111111111111111111111111111');

    // allowance → eth_call to the token with allowance(owner,htlc) calldata; decode uint256.
    rpc._ret = pad((123456).toString(16));
    o.allowance(EO.NET.usdt, function (e, v) {
        T.ok('allowance to token', lastCall.to === EO.NET.usdt);
        T.eq('allowance selector', lastCall.data.slice(0, 10), '0x' + AB.selector('allowance(address,address)'));
        T.eq('allowance decoded', String(v), '123456');
    });

    // canCollect → bool decode.
    rpc._ret = pad('1');
    o.canCollect('0x' + '22'.repeat(32), function (e, v) { T.eq('canCollect true', v, true); });
    rpc._ret = pad('0');
    o.canCollect('0x' + '22'.repeat(32), function (e, v) { T.eq('canCollect false', v, false); });

    // getContract → 12-word decode; owner nonzero required.
    var words = [
        pad('67376c3bf3b5a336b14398920cfbc292013718ea'),   // owner
        pad('11'.repeat(32)),                               // minimaPublicKey
        pad('dead00000000000000000000000000000000beef'),   // receiver
        pad(EO.NET.usdt.replace(/^0x/, '')),                // tokenContract
        pad((5000000).toString(16)),                        // amount
        pad('44b1eec6793b400000'),                          // requestAmount (4.95e18-ish)
        pad('22'.repeat(32)),                               // hashlock
        pad((1800000000).toString(16)),                     // timelock
        pad('0'),                                           // withdrawn
        pad('0'),                                           // refunded
        pad('0'.repeat(64)).slice(0, 64),                   // preimage (zero)
        pad('0')                                            // otc
    ];
    rpc._ret = '0x' + words.join('');
    o.getContract('0x' + '22'.repeat(32), function (e, c) {
        T.ok('getContract non-null', !!c);
        T.eq('getContract owner', c.owner, '0x67376c3bf3b5a336b14398920cfbc292013718ea');
        T.eq('getContract amount', String(c.amount), '5000000');
        T.eq('getContract timelock', String(c.timelock), '1800000000');
        T.eq('getContract withdrawn', c.withdrawn, false);
    });
    // zero owner → null (no such contract).
    rpc._ret = '0x' + [pad('0')].concat(words.slice(1)).join('');
    o.getContract('0x' + '22'.repeat(32), function (e, c) { T.eq('getContract zero-owner → null', c, null); });

    // write ops route through ethtx.send with the correct {to, gas}.
    var savedSend = AX.ethtx.send, sends = [];
    AX.ethtx.send = function (r, priv, addr, chainId, to, data, value, gas, cb) {
        sends.push({ to: to, gas: String(gas), sel: data.slice(0, 10), chainId: chainId });
        cb(null, '0xTX');
    };
    try {
        o.approve(EO.NET.usdt, 0n, function () {});
        o.newContract('0x' + '11'.repeat(32), '0xdead', '0x' + '22'.repeat(32), 1800000000n, EO.NET.usdt, 5000000n, 1n, false, function () {});
        o.withdraw('0x' + '22'.repeat(32), '0x' + '33'.repeat(32), function () {});
        o.refund('0x' + '22'.repeat(32), function () {});
        T.eq('approve → token, 100k gas', [sends[0].to, sends[0].gas], [EO.NET.usdt, '100000']);
        T.eq('approve selector', sends[0].sel, '0x' + AB.selector('approve(address,uint256)'));
        T.eq('newContract → htlc, 500k gas', [sends[1].to, sends[1].gas], [EO.NET.htlc, '500000']);
        T.eq('withdraw → htlc, 500k gas', [sends[2].to, sends[2].gas], [EO.NET.htlc, '500000']);
        T.eq('refund → htlc, 500k gas', [sends[3].to, sends[3].gas], [EO.NET.htlc, '500000']);
        T.eq('all writes chainId 1', [sends[0].chainId, sends[1].chainId], [1, 1]);
    } finally { AX.ethtx.send = savedSend; }
})();

/* decodeGetContract hardening: a malformed/truncated eth_call body (broken or hostile RPC) must yield null —
   a BigInt('0x') throw would escape the async MDS callback chain and wedge the settlement poll forever. */
(function () {
    var EH = AX.ethhtlc;
    T.eq('decode: empty return → null', EH.decodeGetContract('0xCID', '0x'), null);
    T.eq('decode: truncated tuple → null', EH.decodeGetContract('0xCID', '0x1234'), null);
    T.eq('decode: short-by-one-word tuple → null', EH.decodeGetContract('0xCID', '0x' + '11'.repeat(32 * 11)), null);
    T.eq('decode: non-hex garbage → null (no throw)', EH.decodeGetContract('0xCID', '0x' + 'zz'.repeat(32 * 12)), null);
})();
