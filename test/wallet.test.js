/* wallet — the MDS-only manual send: address/amount validation, gas-reserve math (raw balances, never display
   strings), and the exact tx each send hands to the ethtx serializer. Fund-relevant: a wrong recipient, an
   over-balance amount, or a mis-scaled USDT raw would move real funds wrongly. */
(function () {
    var W = AX.wallet, EO = AX.ethops, D = AX.dec;
    var TO = '0x2222222222222222222222222222222222222222';
    var GP = 1000000000n;   // 1 gwei

    // ---- helpers ----
    T.eq('shortAddr 8…6', W.shortAddr('0x7373cf1ff0677a59e9ec7d327c1de0dd67dd625e'), '0x7373cf…dd625e');
    T.eq('isEthAddr ok', W.isEthAddr(TO), true);
    T.eq('isEthAddr rejects short', W.isEthAddr('0x1234'), false);
    T.eq('isEthAddr rejects non-hex', W.isEthAddr('0x' + 'zz'.repeat(20)), false);

    // ---- gas math: reserve mirrors the serializer's +20% headroom ----
    T.eq('gasReserve ETH = 21000 × 1.2gp', W.gasReserveWei(GP, W.GAS_ETH).toString(), (21000n * 1200000000n).toString());
    T.eq('maxEthSend = balance − reserve', W.maxEthSendWei(100000000000000000n, GP).toString(),
        (100000000000000000n - 21000n * 1200000000n).toString());
    T.eq('maxEthSend floors at 0', W.maxEthSendWei(1000n, GP).toString(), '0');

    // ---- checkSend: every refusal path (raw balances, not display strings) ----
    var ETH_1 = 1000000000000000000n, USDT_50 = 50000000n;   // 1 ETH, 50 USDT raw
    T.eq('send eth ok', W.checkSend('eth', TO, '0.5', ETH_1, USDT_50, GP).ok, true);
    T.eq('send eth bad address', W.checkSend('eth', 'nope', '0.5', ETH_1, USDT_50, GP).ok, false);
    T.eq('send eth bad amount', W.checkSend('eth', TO, '1e2', ETH_1, USDT_50, GP).ok, false);
    T.eq('send eth zero', W.checkSend('eth', TO, '0', ETH_1, USDT_50, GP).ok, false);
    T.eq('send eth over balance+gas refused', W.checkSend('eth', TO, '1', ETH_1, USDT_50, GP).ok, false);
    T.eq('send usdt ok', W.checkSend('usdt', TO, '25', ETH_1, USDT_50, GP).ok, true);
    T.eq('send usdt over balance refused', W.checkSend('usdt', TO, '50.000001', ETH_1, USDT_50, GP).ok, false);
    T.eq('send usdt with NO gas ETH refused', W.checkSend('usdt', TO, '25', 0n, USDT_50, GP).ok, false);

    // ---- the exact tx handed to the serializer ----
    var savedSend = AX.ethtx.send, calls = [];
    AX.ethtx.send = function (rpc, priv, from, chainId, to, data, value, gasLimit, cb) {
        calls.push({ chainId: chainId, to: to, data: data, value: value, gasLimit: gasLimit });
        cb(null, '0xTX');
    };
    try {
        W.sendEth({}, '0xPRIV', '0xFROM', TO, '0.25', function (e, h) { T.eq('sendEth broadcasts', h, '0xTX'); });
        T.eq('sendEth → chainId 1, to recipient, empty data', [calls[0].chainId, calls[0].to, calls[0].data], [1, TO, '0x']);
        T.eq('sendEth value = 0.25 ETH in wei', calls[0].value.toString(), '250000000000000000');
        T.eq('sendEth gas 21000', calls[0].gasLimit.toString(), '21000');

        W.sendUsdt({}, '0xPRIV', '0xFROM', TO, '12.5', function (e, h) { T.eq('sendUsdt broadcasts', h, '0xTX'); });
        T.eq('sendUsdt → to the USDT contract, value 0', [calls[1].to, calls[1].value.toString()], [EO.NET.usdt, '0']);
        T.eq('sendUsdt selector = transfer(address,uint256)', calls[1].data.slice(0, 10), '0xa9059cbb');
        T.ok('sendUsdt encodes recipient', calls[1].data.indexOf(TO.slice(2).toLowerCase()) > 0);
        T.ok('sendUsdt encodes 12.5 USDT at 6dp (12500000)', calls[1].data.indexOf((12500000).toString(16)) > 0);
        T.eq('sendUsdt gas 100000', calls[1].gasLimit.toString(), '100000');
    } finally { AX.ethtx.send = savedSend; }
})();
