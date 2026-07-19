/*
 * Runs INSIDE the node's actual Rhino 1.7.14 (via test/rhino.sh) — the release gate that proves the crypto stack
 * produces native-identical bytes on the SAME engine service.js uses (Node/V8 masks Rhino-only bugs: missing
 * Uint8Array.slice/.fill, empty .set RangeError, word-swapped keccak). Rhino shell provides load()/readFile()/print().
 * The scripts (rhino_shim, vendor/*, lib crypto) are load()ed by rhino.sh BEFORE this driver.
 */
var VECTORS = JSON.parse(readFile('test/interop_vectors.json'));
var pass = 0, fail = 0, fails = [];
function eq(name, got, want) { if (String(got) === String(want)) pass++; else { fail++; fails.push(name + '\n    got  ' + got + '\n    want ' + want); } }
function ok(name, cond) { if (cond) pass++; else { fail++; fails.push(name); } }

var H = AX.hex, ID = AX.identity, S = AX.sodium, E = AX.eth, TR = AX.trading;

// deterministic PRNG so seal() round-trips under the Rhino shell (no crypto.getRandomValues here)
(function () { var c = 1; S.setPRNG(function (x, n) { for (var i = 0; i < n; i++) { c = (c * 1103515245 + 12345) & 0x7fffffff; x[i] = c & 0xff; } }); })();

// identities
for (var key in VECTORS.identities) {
    var parts = key.split('|'), id = ID.fromSeed(parts[0], parts[1]), want = VECTORS.identities[key];
    eq(key + ' boxPk', H.to(id.boxPk), want.boxPk);
    eq(key + ' signPk', H.to(id.signPk), want.signPk);
    eq(key + ' publicId', id.publicId(), want.publicId);
}

// open a native-sealed envelope + verify inner sig
(function () {
    var e = VECTORS.envelope, rSeed = null;
    for (var k in VECTORS.identities) if (k.indexOf('0x') === 0 && k.indexOf('usdtswap') > -1) rSeed = k.split('|')[0];
    var recip = ID.fromSeed(rSeed, 'usdtswap');
    var o = ID.openValid(recip, e.sealedBlobHex);
    ok('native-sealed blob opens+valid (RHINO)', !!o);
    eq('plaintext (RHINO)', o && H.utf8Decode(o.plaintext), e.plaintext);
    eq('from (RHINO)', o && o.fromPublicId, e.senderPublicId);
})();

// production seal → open round-trip (needs .fill for blake2b nonce, .slice)
(function () {
    var sender = ID.fromSeed('taker-seed', 'usdtswap');
    var recip = ID.fromSeed('0xDEADBEEF00000000000000000000000000000000000000000000000000000009', 'usdtswap');
    var blob = ID.seal(sender, recip.publicId(), H.utf8('{"hash":"0xABCD"}'));
    var o = ID.openValid(recip, blob);
    ok('round-trip opens (RHINO seal .fill/.slice)', !!o && H.utf8Decode(o.plaintext) === '{"hash":"0xABCD"}');
})();

// bare Ed25519 order-book signature
eq('order sig verifies (RHINO)', S.signVerify(H.from(VECTORS.sign.sigHex), H.utf8(VECTORS.sign.message), H.from(VECTORS.sign.signPk)), true);

// ETH address (keccak .array not .arrayBuffer) + legacy tx signing (.slice + empty .set)
eq('ETH address (RHINO keccak)', E.addressFromPriv(VECTORS.eth.privKey).toLowerCase(), VECTORS.eth.address.toLowerCase());
eq('ETH tx signed bytes (RHINO)', E.signLegacyTx(VECTORS.eth.tx, VECTORS.eth.privKey, VECTORS.eth.tx.chainId).toLowerCase(), VECTORS.eth.tx.signedHex.toLowerCase());

// sentinels
eq('MXUSDT orderbook', TR.MXUSDT.orderBookAddr, '0x5553445453574150');
eq('MXUSDT hkdf ctx', TR.MXUSDT.hkdfContext, 'usdtswap');

// exact decimal math (BigInt on real Rhino) — grain/floor/ceil/mul/div
var D = AX.dec;
eq('RHINO grain6 floors', D.grain6('4.9505009'), '4.9505');
eq('RHINO mulFloor', D.mulFloor('4.95', '0.99', 6), '4.9005');
eq('RHINO divFloor', D.divFloor('5', '1.01', 6), '4.950495');
eq('RHINO parseUnits 18dp', D.parseUnits('4.950495', 18).toString(), '4950495000000000000');

// ETH ABI calldata + deterministic contractId (keccak selector + BigInt words) vs web3j vectors
var AB = AX.abi, EH = AX.ethhtlc, V = VECTORS.abi;
eq('RHINO selector approve', AB.selector('approve(address,uint256)'), '095ea7b3');
eq('RHINO approve calldata', EH.approve(EH.NET.htlc, 0).data, V.approveData);
eq('RHINO newContract calldata',
    EH.newContract(V.senderMinima, V.receiverEth, V.hashlock, BigInt(V.timelock), V.token, BigInt(V.amount), BigInt(V.requestAmount), false).data,
    V.newContractData);
eq('RHINO withdraw calldata', EH.withdraw(V.hashlock, V.preimage).data, V.withdrawData);
eq('RHINO contractId', EH.contractId(V.hashlock), V.contractId);

print('\n' + (fail === 0 ? 'RHINO: ALL PASS' : 'RHINO: FAILURES') + ' — ' + pass + ' passed, ' + fail + ' failed');
if (fail) { print(fails.join('\n')); quit(1); }
quit(0);
