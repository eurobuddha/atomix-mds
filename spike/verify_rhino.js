/**
 * SPIKE 0c (Rhino path) — prove the pure-JS / no-WASM sodium stack reproduces the native bytes.
 * Same assertions as verify_vectors.js but through rhino_sodium.js (tweetnacl + blakejs + js-sha256/512),
 * which is what can actually run inside the MDS service.js Rhino engine.
 */
const fs = require('fs');
const S = require('./rhino_sodium.js');
const V = JSON.parse(fs.readFileSync(__dirname + '/interop_vectors.json', 'utf8'));

const hex = (u8) => Buffer.from(u8).toString('hex');
const unhex = (h) => new Uint8Array(Buffer.from(h.replace(/^0x/, ''), 'hex'));
const seedBytes = (s) => s.startsWith('0x') ? unhex(s) : new Uint8Array(Buffer.from(s, 'utf8'));
const info = (s) => new Uint8Array(Buffer.from(s, 'utf8'));

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('  ✅', n); } else { fail++; console.log('  ❌', n); } };

console.log('— identity derivation (Rhino sodium) —');
for (const [key, want] of Object.entries(V.identities)) {
    const [seed, ctx] = key.split('|');
    const box = S.boxSeedKeypair(S.hkdfSha256(seedBytes(seed), info(ctx + '-box-v1'), 32));
    const sign = S.signSeedKeypair(S.hkdfSha256(seedBytes(seed), info(ctx + '-sign-v1'), 32));
    ok(`${key} boxPk`, hex(box.publicKey) === want.boxPk);
    ok(`${key} signPk`, hex(sign.publicKey) === want.signPk);
    ok(`${key} publicId`, '0x' + hex(box.publicKey) + hex(sign.publicKey) === want.publicId);
}

console.log('— open native-sealed envelope + verify inner sig (Rhino sodium) —');
{
    const e = V.envelope;
    const rSeedKey = Object.keys(V.identities).find(k => k.startsWith('0x') && k.endsWith('usdtswap'));
    const rSeed = rSeedKey.split('|')[0];
    const rBox = S.boxSeedKeypair(S.hkdfSha256(seedBytes(rSeed), info('usdtswap-box-v1'), 32));
    const payload = S.sealOpen(unhex(e.sealedBlobHex), rBox.publicKey, rBox.privateKey);
    ok('native-sealed blob opens', !!payload);
    const p = JSON.parse(Buffer.from(payload).toString('utf8'));
    ok('plaintext matches', Buffer.from(unhex(p.b)).toString('utf8') === e.plaintext);
    const signed = new Uint8Array([...unhex(p.f), ...unhex(p.b)]);
    ok('inner Ed25519 sig verifies', S.signVerify(unhex(p.s), signed, unhex(p.f).slice(32, 64)));
}

console.log('— round-trip: JS seal → JS open (sealed box symmetric) —');
{
    const rSeedKey = Object.keys(V.identities).find(k => k.startsWith('0x') && k.endsWith('usdtswap'));
    const rBox = S.boxSeedKeypair(S.hkdfSha256(seedBytes(rSeedKey.split('|')[0]), info('usdtswap-box-v1'), 32));
    const msg = new Uint8Array(Buffer.from('{"hash":"0xDEAD"}', 'utf8'));
    const blob = S.seal(msg, rBox.publicKey);
    const back = S.sealOpen(blob, rBox.publicKey, rBox.privateKey);
    ok('JS seal → JS open round-trips', !!back && Buffer.from(back).toString('utf8') === '{"hash":"0xDEAD"}');
}

console.log('— bare order-book Ed25519 sig (Rhino sodium) —');
{
    const s = V.sign;
    ok('sig verifies vs native signPk', S.signVerify(unhex(s.sigHex), new Uint8Array(Buffer.from(s.message, 'utf8')), unhex(s.signPk)));
}

console.log(`\n${fail === 0 ? 'ALL PASS (Rhino-safe stack)' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
