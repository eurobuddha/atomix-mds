/**
 * RHINO-COMPATIBLE ETH legacy-EIP-155 signer — the maker's counter-leg lock, claims and refunds run in
 * service.js (Rhino, no BigInt-heavy ethers). Pure JS: elliptic (secp256k1) + js-sha3 (keccak256) + manual RLP.
 * Must produce byte-identical output to web3j's TransactionEncoder.signMessage(raw, chainId, creds).
 */
const EC = require('elliptic').ec;
const { keccak256 } = require('js-sha3');
const secp = new EC('secp256k1');

const unhex = (h) => Buffer.from((h || '').replace(/^0x/, ''), 'hex');
const keccakBytes = (u8) => Buffer.from(keccak256.arrayBuffer(u8));

/** minimal big-endian bytes for a non-negative integer given as decimal string or number (0 → empty). */
function intToMinimalBytes(v) {
    let hex = BigInt(v).toString(16);
    if (hex === '0') return Buffer.alloc(0);
    if (hex.length % 2) hex = '0' + hex;
    return Buffer.from(hex, 'hex');
}

function rlpEncodeBytes(buf) {
    if (buf.length === 1 && buf[0] < 0x80) return buf;
    return Buffer.concat([rlpLenPrefix(buf.length, 0x80), buf]);
}
function rlpLenPrefix(len, offset) {
    if (len < 56) return Buffer.from([offset + len]);
    const lenBytes = intToMinimalBytes(len);
    return Buffer.concat([Buffer.from([offset + 55 + lenBytes.length]), lenBytes]);
}
function rlpEncodeList(items) {
    const body = Buffer.concat(items.map(rlpEncodeBytes));
    return Buffer.concat([rlpLenPrefix(body.length, 0xc0), body]);
}

/** Sign a legacy EIP-155 tx. Fields: nonce, gasPriceWei, gasLimit (ints); to (0x addr); value (int); data (0x). */
function signLegacyTx(tx, privHex, chainId) {
    const nonce = intToMinimalBytes(tx.nonce);
    const gasPrice = intToMinimalBytes(tx.gasPriceWei);
    const gasLimit = intToMinimalBytes(tx.gasLimit);
    const to = unhex(tx.to);
    const value = intToMinimalBytes(tx.value);
    const data = unhex(tx.data);

    // EIP-155 signing payload: [nonce,gasPrice,gasLimit,to,value,data,chainId,0,0]
    const sigPayload = rlpEncodeList([nonce, gasPrice, gasLimit, to, value, data,
        intToMinimalBytes(chainId), Buffer.alloc(0), Buffer.alloc(0)]);
    const msgHash = keccakBytes(sigPayload);

    const key = secp.keyFromPrivate(unhex(privHex));
    const sig = key.sign(msgHash, { canonical: true });
    const r = Buffer.from(sig.r.toArray('be', 32));
    const s = Buffer.from(sig.s.toArray('be', 32));
    const v = intToMinimalBytes(sig.recoveryParam + chainId * 2 + 35);

    const signed = rlpEncodeList([nonce, gasPrice, gasLimit, to, value, data, v, r, s]);
    return '0x' + signed.toString('hex');
}

module.exports = { signLegacyTx };
