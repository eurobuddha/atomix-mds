/*
 * Browser-UI render smoke (jsdom) — ui.js/app.js use `document`, so they run outside the Rhino sandbox. This
 * renders every tab from a fake live book + swaps and asserts structure (no throw, correct elements/copy). Catches
 * DOM-build regressions the pure-logic harness can't. Run: node test/ui_render.js
 */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const dom = new JSDOM('<!DOCTYPE html><html data-theme="dark" data-ccy="mxusdt"><body><div id="root"></div></body></html>');
global.window = dom.window;
global.document = dom.window.document;
globalThis.document = dom.window.document;
// entropy for any seal path (not used in render, but ax_sodium.setPRNG must be callable)
const nc = require('crypto');

const FILES = [
    'lib/rhino_shim.js', 'vendor/nacl.js', 'vendor/blake.js', 'vendor/sha256.js', 'vendor/sha512.js', 'vendor/sha3.js', 'vendor/elliptic.js',
    'lib/hex.js', 'lib/flow.js', 'crypto/ax_sodium.js', 'crypto/ax_eth.js', 'lib/decimal.js', 'lib/identity.js', 'lib/trading.js',
    'lib/order.js', 'lib/orderbook.js', 'lib/swapplan.js', 'lib/abi.js', 'lib/ethhtlc.js', 'lib/ethrpc.js', 'lib/ethtx.js', 'lib/ethops.js', 'lib/wallet.js', 'vendor/qrcode.js', 'lib/fmt.js', 'lib/ui.js'
];
const vm = require('vm');
for (const f of FILES) { try { vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f }); } catch (e) { console.error('LOAD', f, e); process.exit(1); } }
AX.sodium.setPRNG((x, n) => { const b = nc.randomBytes(n); for (let i = 0; i < n; i++) x[i] = b[i]; });

let pass = 0, fail = 0, fails = [];
const ok = (n, c) => c ? pass++ : (fail++, fails.push(n));

// fake state: two makers at the same best price (deepest first), balances, an in-flight swap
function mk(signer, ts, bid, ask, size, u) { var o = AX.order.make(); o.signerPk = signer; o.ts = ts; o.usdtAvail = u; o.minimaAvail = 500; var p = AX.order.pair(true, ask, bid, 0.01); p.asks.push(AX.order.level(ask, size)); p.bids.push(AX.order.level(bid, size)); o.pairs.USDT = p; return o; }
const me = AX.identity.fromSeed('ui-smoke-seed', 'usdtswap');
AX.ui.state.ctx = { identities: { minima: AX.identity.fromSeed('ui-smoke-seed', 'minimaswap'), mxusdt: me },
    eth: { address: '0x7373cf1ff0677a59e9ec7d327c1de0dd67dd625e', privKey: '0x' + '11'.repeat(32) } };
AX.ui.state.balsMeta = { confirmed: '500.3', unconfirmed: '0', sendable: '493.8', coins: 7, at: Date.now() };
AX.ui.state.book = { '0xAA': mk('0xAA', 200, 0.99, 1.01, 30, 29.7), '0xBB': mk('0xBB', 100, 0.99, 1.01, 5, 4.95) };
AX.ui.state.bals = { minima: '493.8', usdt: '8.44', eth: '0.01' };
AX.ui.state.swaps = [{ hash: '0xh', role: 'INITIATOR', direction: 'MINIMA_TO_ERC20', selltoken: AX.trading.USDT_TOKENID, sellamount: '6.5', buytoken: 'ETH', buyamount: '6.435', status: 'STARTED' }];
AX.ui.setState({ book: AX.ui.state.book });   // recomputes quote

function root() { return document.getElementById('root'); }
['swap', 'wallet', 'activity', 'market', 'otc'].forEach(function (t) {
    AX.ui.state.tab = t;
    try { AX.ui.render(); } catch (e) { fail++; fails.push('render ' + t + ' threw: ' + e); return; }
    ok(t + ': #app built', !!root().querySelector('#app'));
    ok(t + ': brand present', root().textContent.indexOf('AtomiX') > -1);
    ok(t + ': 5 tabs', root().querySelectorAll('#tabbar .tab').length === 5);
    ok(t + ': mainnet chip', root().textContent.indexOf('Mainnet') > -1);
});

// tab-specific structure
AX.ui.state.tab = 'swap'; AX.ui.render();
ok('swap: Review CTA', root().textContent.indexOf('Review swap') > -1);
ok('swap: best price line', root().textContent.indexOf('Best price 0.99') > -1);
ok('swap: YOUR SWAP tracker', root().textContent.indexOf('YOUR SWAP') > -1);
ok('swap: in-flight leg copy', root().textContent.indexOf('Locked your 6.5') > -1);

AX.ui.state.tab = 'market'; AX.ui.render();
ok('market: order book count', root().textContent.indexOf('Order book  ·  2 live') > -1);
ok('market: depth rows rendered', root().querySelectorAll('.depth').length >= 1);
ok('market: best row deepest-first (cap30 before cap5)', root().querySelector('.depth.best').textContent.indexOf('30') > -1);
ok('market: legend', root().textContent.indexOf('SELL mxUSDT (bid)') > -1);

AX.ui.state.tab = 'wallet'; AX.ui.render();
ok('wallet: minima balance', root().textContent.indexOf('493.8 mxUSDT') > -1);
ok('wallet: USDT card', root().textContent.indexOf('8.44 USDT') > -1);
ok('wallet: ETH address sub-line (8…6)', root().textContent.indexOf('0x7373cf…dd625e') > -1);
ok('wallet: Minima breakdown line', root().textContent.indexOf('confirmed 500.3') > -1 && root().textContent.indexOf('7 coins') > -1);
ok('wallet: Send pill present', root().textContent.indexOf('↑  Send') > -1);
ok('wallet: NO stub button behavior text', root().textContent.indexOf('Coming in a later phase') < 0);

// receive dialog: full address + a real QR <img> + the all-EVM note + Copy
root().querySelectorAll('.pill').forEach(function (p) { if (p.textContent.indexOf('Fund / QR') > -1) p.dispatchEvent(new dom.window.Event('click')); });
AX.ui.render();
ok('receive: title', root().textContent.indexOf('Receive / Fund · Ethereum') > -1);
ok('receive: full address selectable', root().textContent.indexOf('0x7373cf1ff0677a59e9ec7d327c1de0dd67dd625e') > -1);
ok('receive: QR img rendered', !!root().querySelector('.modal-card img'));
ok('receive: all-EVM note', root().textContent.indexOf('Same address on all EVM networks') > -1);
ok('receive: Copy address button', root().textContent.indexOf('Copy address') > -1);
AX.ui.closeDialog();

// export key: warning step → reveal step shows the key
root().querySelectorAll('.pill').forEach(function (p) { if (p.textContent.indexOf('Export key') > -1) p.dispatchEvent(new dom.window.Event('click')); });
AX.ui.render();
ok('export: warning first', root().textContent.indexOf('This key controls your ETH funds') > -1);
ok('export: reveal CTA', root().textContent.indexOf('Reveal key') > -1);
root().querySelectorAll('.cta').forEach(function (b) { if (b.textContent === 'Reveal key') b.dispatchEvent(new dom.window.Event('click')); });
AX.ui.render();
ok('export: key revealed', root().textContent.indexOf('0x' + '11'.repeat(32)) > -1);
ok('export: secret warning', root().textContent.indexOf('Keep this secret') > -1);
AX.ui.closeDialog();

// send dialog: form fields render; typing state survives a re-render (the never-wipe-a-live-form rule)
root().querySelectorAll('.pill').forEach(function (p) { if (p.textContent.indexOf('↑  Send') > -1) p.dispatchEvent(new dom.window.Event('click')); });
AX.ui.render();
ok('send: form title', root().textContent.indexOf('Send from this wallet') > -1);
ok('send: asset pills', root().textContent.indexOf('USDT') > -1 && root().querySelector('.modal-card input') != null);
var sendInput = root().querySelector('.modal-card input');
sendInput.value = '0xabc'; sendInput.dispatchEvent(new dom.window.Event('input'));
AX.ui.render();   // poll-style re-render
ok('send: typed value SURVIVES a re-render', root().querySelector('.modal-card input').value === '0xabc');
ok('send: irreversibility note', root().textContent.indexOf('Sends are irreversible') > -1);
AX.ui.closeDialog();

// coins dialog (breakdown tap target)
AX.ui.coinsDialog([{ amount: '400.3', coinid: '0x' + 'aa'.repeat(32) }, { amount: '93.5', coinid: '0x' + 'bb'.repeat(32) }]);
ok('coins: title', root().textContent.indexOf('Your mxUSDT coins') > -1);
ok('coins: rows', root().textContent.indexOf('400.3') > -1 && root().textContent.indexOf('93.5') > -1);
AX.ui.closeDialog();

// custom slippage: form dialog opens from the pill (slippage row renders in BUY mode)
AX.ui.state.tab = 'swap'; AX.ui.state.sell = false; AX.ui.render();
root().querySelectorAll('.pill').forEach(function (p) { if (p.textContent === 'Custom') p.dispatchEvent(new dom.window.Event('click')); });
AX.ui.render();
ok('slippage: custom dialog', root().textContent.indexOf('Custom max slippage') > -1);
AX.ui.closeDialog();

AX.ui.state.tab = 'activity'; AX.ui.render();
ok('activity: swap card', root().textContent.indexOf('6.5') > -1 && root().textContent.indexOf('waiting') > -1);

// currency re-theme flips data-ccy → accent
AX.trading.setActive(AX.trading.MINIMA); AX.ui.render();
ok('minima re-theme sets data-ccy', document.documentElement.getAttribute('data-ccy') === 'minima');
ok('minima label in header', root().textContent.indexOf('MINIMA') > -1);
AX.trading.setActive(AX.trading.MXUSDT);

// boot-failure states (the Classic first-run): permission card with the exact grant command, no native-isms
AX.ui.state.paired = false; AX.ui.state.bootError = { permission: true }; AX.ui.render();
ok('boot: permission card title', root().textContent.indexOf('needs Write permission') > -1);
ok('boot: exact grant command shown', root().textContent.indexOf('mds action:permission uid:') > -1);
ok('boot: retry button', root().textContent.indexOf('Retry now') > -1);
ok('boot: NO minimaCore native-ism anywhere', root().textContent.indexOf('Minima Core') < 0);
AX.ui.state.bootError = { locked: true }; AX.ui.render();
ok('boot: locked card', root().textContent.indexOf('password-locked') > -1);
AX.ui.state.bootError = null; AX.ui.render();
ok('boot: no error → starting banner copy', root().textContent.indexOf('Starting AtomiX') > -1);
AX.ui.state.paired = true; AX.ui.state.bootError = null; AX.ui.render();
ok('boot: paired → no overlay', root().textContent.indexOf('needs Write permission') < 0);

console.log('\n' + (fail === 0 ? '✅ UI RENDER PASS' : '❌ UI RENDER FAIL') + ` — ${pass} passed, ${fail} failed`);
if (fail) { console.log(fails.join('\n')); process.exit(1); }
