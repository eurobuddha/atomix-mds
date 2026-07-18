/**
 * RHINO-COMPATIBLE pure-JS sodium — the make-or-break of the MDS port.
 *
 * MDS service.js runs on Rhino 1.7.14 (ES6) with NO WebAssembly, NO WebCrypto, NO Node built-ins — so
 * libsodium-wrappers (WASM) cannot run there. This module reproduces the exact libsodium primitives AtomiX uses,
 * from pure-JS deps that run under Rhino: tweetnacl (X25519 + Ed25519 + XSalsa20-Poly1305), blakejs (blake2b for
 * the sealed-box nonce), js-sha256/js-sha512 (HKDF + box seed hash). Byte-identical to lazysodium is REQUIRED.
 *
 * libsodium internals reproduced:
 *   crypto_box_seed_keypair(seed): sk = SHA512(seed)[0:32]; pk = X25519_base(sk)
 *   crypto_sign_seed_keypair(seed): Ed25519 standard seed keypair
 *   crypto_box_seal(m, rpk): ek=ephemeral X25519; nonce = blake2b(ek.pk || rpk, 24); c = box(m, nonce, rpk, ek.sk); out = ek.pk || c
 *   crypto_box_seal_open(c, rpk, rsk): ek.pk = c[0:32]; nonce = blake2b(ek.pk || rpk, 24); box_open(c[32:], nonce, ek.pk, rsk)
 */
const nacl = require('tweetnacl');
const blake = require('blakejs');
const { sha512 } = require('js-sha512');
const { sha256 } = require('js-sha256');

function hmacSha256(keyBytes, msgBytes) {
    return new Uint8Array(sha256.hmac.arrayBuffer(keyBytes, msgBytes));
}

/** HKDF-SHA256 (RFC 5869) — matches native Hkdf.java: salt = zeros(32), info string, L=32. */
function hkdfSha256(ikm, info, length) {
    const salt = new Uint8Array(32);
    const prk = hmacSha256(salt, ikm);
    const out = new Uint8Array(length);
    let t = new Uint8Array(0), pos = 0, counter = 1;
    while (pos < length) {
        const input = new Uint8Array(t.length + info.length + 1);
        input.set(t, 0); input.set(info, t.length); input[input.length - 1] = counter;
        t = hmacSha256(prk, input);
        const take = Math.min(t.length, length - pos);
        out.set(t.subarray(0, take), pos);
        pos += take; counter++;
    }
    return out;
}

/** crypto_box_seed_keypair: sk = SHA512(seed)[0:32], pk = X25519 base(sk). */
function boxSeedKeypair(seed) {
    const h = new Uint8Array(sha512.arrayBuffer(seed));
    const sk = h.slice(0, 32);
    const kp = nacl.box.keyPair.fromSecretKey(sk);   // tweetnacl clamps + base-mults internally
    return { publicKey: kp.publicKey, privateKey: kp.secretKey };
}

/** crypto_sign_seed_keypair: standard Ed25519 seed keypair. */
function signSeedKeypair(seed) {
    const kp = nacl.sign.keyPair.fromSeed(seed);
    return { publicKey: kp.publicKey, privateKey: kp.secretKey };
}

/** crypto_box_seal_open: ephemeral pk = c[0:32]; nonce = blake2b(epk||rpk, 24); box_open. */
function sealOpen(cipher, rpk, rsk) {
    const epk = cipher.slice(0, 32);
    const boxed = cipher.slice(32);
    const nonce = blake.blake2b(new Uint8Array([...epk, ...rpk]), null, 24);
    return nacl.box.open(boxed, nonce, epk, rsk);   // null on failure
}

/** crypto_box_seal: ephemeral keypair; nonce = blake2b(epk||rpk,24); out = epk || box(m,nonce,rpk,esk). */
function seal(message, rpk) {
    const ek = nacl.box.keyPair();
    const nonce = blake.blake2b(new Uint8Array([...ek.publicKey, ...rpk]), null, 24);
    const boxed = nacl.box(message, nonce, rpk, ek.secretKey);
    return new Uint8Array([...ek.publicKey, ...boxed]);
}

const signDetached = (msg, sk) => nacl.sign.detached(msg, sk);
const signVerify = (sig, msg, pk) => nacl.sign.detached.verify(msg, sig, pk);

module.exports = { hkdfSha256, boxSeedKeypair, signSeedKeypair, seal, sealOpen, signDetached, signVerify };
