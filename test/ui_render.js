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
    'lib/order.js', 'lib/orderbook.js', 'lib/swapplan.js', 'lib/fmt.js', 'lib/ui.js'
];
const vm = require('vm');
for (const f of FILES) { try { vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f }); } catch (e) { console.error('LOAD', f, e); process.exit(1); } }
AX.sodium.setPRNG((x, n) => { const b = nc.randomBytes(n); for (let i = 0; i < n; i++) x[i] = b[i]; });

let pass = 0, fail = 0, fails = [];
const ok = (n, c) => c ? pass++ : (fail++, fails.push(n));

// fake state: two makers at the same best price (deepest first), balances, an in-flight swap
function mk(signer, ts, bid, ask, size, u) { var o = AX.order.make(); o.signerPk = signer; o.ts = ts; o.usdtAvail = u; o.minimaAvail = 500; var p = AX.order.pair(true, ask, bid, 0.01); p.asks.push(AX.order.level(ask, size)); p.bids.push(AX.order.level(bid, size)); o.pairs.USDT = p; return o; }
const me = AX.identity.fromSeed('ui-smoke-seed', 'usdtswap');
AX.ui.state.ctx = { identities: { minima: AX.identity.fromSeed('ui-smoke-seed', 'minimaswap'), mxusdt: me } };
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
