/* Byte-interop: the production AX.* modules must reproduce the native (lazysodium/web3j) vectors exactly. */
(function () {
    var H = AX.hex, ID = AX.identity, S = AX.sodium, E = AX.eth, TR = AX.trading;

    T.log('— identity derivation (production modules) —');
    for (var key in VECTORS.identities) {
        var parts = key.split('|'), seed = parts[0], ctx = parts[1], want = VECTORS.identities[key];
        var id = ID.fromSeed(seed, ctx);
        T.eq(key + ' boxPk', H.to(id.boxPk), want.boxPk);
        T.eq(key + ' signPk', H.to(id.signPk), want.signPk);
        T.eq(key + ' publicId', id.publicId(), want.publicId);
    }

    T.log('— open a native-sealed envelope + verify inner sig —');
    (function () {
        var e = VECTORS.envelope;
        // recipient = the 0x-hex seed under usdtswap
        var rSeed = null;
        for (var k in VECTORS.identities) if (k.indexOf('0x') === 0 && k.indexOf('usdtswap') > -1) rSeed = k.split('|')[0];
        var recip = ID.fromSeed(rSeed, 'usdtswap');
        var opened = ID.open(recip, e.sealedBlobHex);
        T.ok('native-sealed blob opens', !!opened);
        T.ok('inner signature valid', !!opened && opened.valid);
        T.eq('plaintext matches', opened && H.utf8Decode(opened.plaintext), e.plaintext);
        T.eq('from = native sender', opened && opened.fromPublicId, e.senderPublicId);
    })();

    T.log('— round-trip: production seal → production open —');
    (function () {
        var sender = ID.fromSeed('some-taker-seed', 'usdtswap');
        var recip = ID.fromSeed('0xDEADBEEF00000000000000000000000000000000000000000000000000000001', 'usdtswap');
        var msg = H.utf8('{"hash":"0xC0FFEE"}');
        var blob = ID.seal(sender, recip.publicId(), msg);
        var opened = ID.open(recip, blob);
        T.ok('round-trip opens', !!opened && opened.valid);
        T.eq('round-trip plaintext', opened && H.utf8Decode(opened.plaintext), '{"hash":"0xC0FFEE"}');
        T.eq('round-trip from', opened && opened.fromPublicId, sender.publicId());
        // a different recipient must NOT be able to open it
        var other = ID.fromSeed('0xDEADBEEF00000000000000000000000000000000000000000000000000000002', 'usdtswap');
        T.ok('wrong recipient cannot open', ID.open(other, blob) === null);
    })();

    T.log('— bare Ed25519 order-book signature —');
    (function () {
        var s = VECTORS.sign;
        T.ok('sig verifies vs native signPk', S.signVerify(H.from(s.sigHex), H.utf8(s.message), H.from(s.signPk)));
    })();

    T.log('— ETH address + legacy tx signing (production) —');
    (function () {
        T.eq('address from seedrandom privkey', E.addressFromPriv(VECTORS.eth.privKey).toLowerCase(), VECTORS.eth.address.toLowerCase());
        var tx = VECTORS.eth.tx;
        T.eq('legacy tx signed bytes', E.signLegacyTx(tx, VECTORS.eth.privKey, tx.chainId).toLowerCase(), tx.signedHex.toLowerCase());
    })();

    T.log('— trading sentinels/tokens (interop anchors) —');
    (function () {
        T.eq('MINIMA orderbook', TR.MINIMA.orderBookAddr, '0x4D494E494D4153574150');
        T.eq('MXUSDT orderbook', TR.MXUSDT.orderBookAddr, '0x5553445453574150');
        T.eq('MXUSDT hkdf context', TR.MXUSDT.hkdfContext, 'usdtswap');
        T.eq('MINIMA hkdf context', TR.MINIMA.hkdfContext, 'minimaswap');
        T.eq('USDT tokenid', TR.USDT_TOKENID, '0x7D39745FBD29049BE29850B55A18BF550E4D442F930F86266E34193D89042A90');
        T.eq('default active = mxUSDT', TR.active().key, 'mxusdt');
        TR.loadKey('minima'); T.eq('loadKey switches', TR.active().key, 'minima'); TR.loadKey('mxusdt');
    })();
})();
