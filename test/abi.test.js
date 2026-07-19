/* ABI encode + ETH-HTLC calldata byte-verified against the web3j-generated interop vectors (VECTORS.abi). */
(function () {
    var A = AX.abi, E = AX.ethhtlc, V = VECTORS.abi;

    // ---- selectors (keccak256(sig)[0:4]) ----
    T.eq('selector approve', A.selector('approve(address,uint256)'), '095ea7b3');
    T.eq('selector transfer', A.selector('transfer(address,uint256)'), 'a9059cbb');
    T.eq('selector withdraw', A.selector('withdraw(bytes32,bytes32)'), A.selector('withdraw(bytes32,bytes32)'));

    // ---- full calldata vs web3j FunctionEncoder ----
    // approve(htlc, 0) — the Tether zero-first reset the vector encodes.
    T.eq('approve calldata == web3j', E.approve(E.NET.htlc, 0n).data, V.approveData);
    // newContract(senderMinimaPk, receiver, hashlock, timelock, token, amount, requestAmount, otc=false)
    T.eq('newContract calldata == web3j',
        E.newContract(V.senderMinima, V.receiverEth, V.hashlock, BigInt(V.timelock), V.token, BigInt(V.amount), BigInt(V.requestAmount), false).data,
        V.newContractData);
    // withdraw(hashlock-as-bytes32, preimage) — the vector's two bytes32 words
    T.eq('withdraw calldata == web3j', E.withdraw(V.hashlock, V.preimage).data, V.withdrawData);

    // ---- deterministic contractId = sha256(b32(hashlock)) ----
    T.eq('contractId == sha256(b32(hashlock))', E.contractId(V.hashlock), V.contractId);

    // ---- bytes32 rule: keep the LAST 32 bytes when longer (native b32) ----
    var long = '0x' + 'ab'.repeat(40);           // 40 bytes → keep last 32
    T.eq('encBytes32 keeps last 32', A.encodeCall('withdraw(bytes32,bytes32)', [{ t: 'bytes32', v: long }, { t: 'bytes32', v: '0x00' }]).slice(10, 74), 'ab'.repeat(32));

    // ---- decode round-trips a getContract-shaped uint256 word ----
    var dec = A.decode(['uint256', 'bool', 'address'], A.pad64((5000000).toString(16)) + A.pad64('1') + A.pad64('67376c3bf3b5a336b14398920cfbc292013718ea'));
    T.eq('decode uint256', dec[0].toString(), '5000000');
    T.eq('decode bool', dec[1], true);
    T.eq('decode address', dec[2], '0x67376c3bf3b5a336b14398920cfbc292013718ea');
})();
