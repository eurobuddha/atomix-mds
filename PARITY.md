# PARITY — native AtomiX ↔ AtomiX MDS feature ledger

**This file is the only thing allowed to claim "parity."** Every native screen, control, dialog and behavior
gets a row. A release may not describe itself as parity-complete while any row is ⏳. Statuses:
✅ implemented + covered by tests · 📱 additionally verified on a real node · ⏳ gap · ✖ n/a (reason given).
The browser-chain gate additionally asserts NO stub helper exists in the UI (a "coming later" button once
shipped to a real node — never again).

Native references are `MainActivity.java` (m), `SwapEngine.java` (e) in `minima-core-android-atomix` @ 0.1.8.

**FIELD EVIDENCE (2026-07-19): two real mainnet interop swaps — AtomiX MDS 0.1.6 (TAKER, minimega node) ↔
native AtomiX (MAKER, Z Fold): mxUSDT→USDT and USDT→mxUSDT, both settled cleanly, balances reconciled.**
Validates: identity seal/open interop, book read, take handshake, HTLC lock construction, ETH signing, both
taker settlement claims. Still pending field-verification: the MDS MAKER/responder side (matrix cases 3+4),
MINIMA mode, OTC cross-peer, refund, tombstone-cross-peer, sweep, mid-swap switch.

## Shell
| Native | MDS | Status |
|---|---|---|
| 5 tabs Swap/Wallet/Activity/Market/OTC (m:131) | ui.js tabbar | 📱 |
| Currency pill switch + full re-theme f(currency×dark/light) | ui.js header + data-ccy CSS | 📱 |
| Dark/light toggle | ui.js | 📱 |
| Welcome/help dialog (m:2650) | ui.js welcomeDialog (first-run once + header ? pill; MDS-correct Write-permission bullet — native's title still says 'usdtSwap': flagged for native backport) | ✅ 0.1.7 |

## Swap tab
| Native | MDS | Status |
|---|---|---|
| Bidirectional dual-amount card, best-price quote | ui.js swap card + swapplan | 📱 |
| Single-swap + best-price-first sweep routing (largest-cap-first at equal price) | swapplan/orderbook (RoutingOrder tests ported) | ✅ |
| Slippage pills 2% / 4.2% | ui.js slippageRow | 📱 |
| Custom slippage input | ui.js customSlippageDialog (clamp 0.1–50) | ✅ 0.1.6 |
| Take-time makerLive guard + periodic book re-scan | engine.startLeg + app.js 90s scan | ✅ |
| Swap stages tracker ("YOUR SWAP") | ui.js stages() | 📱 |

## Wallet tab
| Native | MDS | Status |
|---|---|---|
| Minima card + breakdown sub-line (confirmed/locked/unconfirmed/coins/updated) (m:2521,665) | ui.js walletCard + balsMeta | ✅ 0.1.6 |
| Coin dump (long-press → tap on web) (m:2523) | app.js onCoinDump → ui.coinsDialog | ✅ 0.1.6 |
| ETH card with shortAddr sub-line, tap → receive (m:2526) | ui.js walletTab | ✅ 0.1.6 |
| USDT card | ui.js walletCard | 📱 |
| Refresh pill (both chains) (m:2544) | app.js onRefreshBal | ✅ 0.1.6 |
| Fund/QR receive dialog: full address + QR(plain address, white quiet-zone) + all-EVM note + Copy (m:3222) | ui.js receiveDialog (vendored qrcode.js, MIT) | ✅ 0.1.6 |
| Export key 2-step warning → reveal → Copy (m:3264/3275) | ui.js exportKeyDialog/revealKeyDialog | ✅ 0.1.6 |
| Balance pulse on swap completion (m:2569) | ui.js walletCard pulse (one-shot on value change) | ✅ 0.1.7 |
| **Manual Send ETH/USDT** | **MDS-ONLY EXTRA (user decision 2026-07-19)** — lib/wallet.js via the shared ethtx nonce serializer + ax_ethlock; native stays receive-only | ✅ 0.1.6 (MDS only, deliberate divergence) |

## Activity tab
| Native | MDS | Status |
|---|---|---|
| Per-swap cards with live status | ui.js activityTab (reads swaps SQL) | 📱 |
| Swap detail breakdown (legs found/claimable) (e:400-484 inspect + m:2930 checkNow) | lib/inspect.js buildReport (pure, native strings) + app.js onSwapDetail live reads + ui.swapReportDialog w/ Check again | ✅ 0.1.7 |

## Market tab
| Native | MDS | Status |
|---|---|---|
| Live order book, deepest-first at equal price, tombstone-aware | orderbook.js + ui.js depth rows | 📱 |
| Maker order editor (peg ladder, levels 1–6 default 1, manual ladder) | maker.js + ui.js editor | ✅ |
| Publish / keep-alive / withdraw / currency-switch tombstone | maker.js + service reloadShared | ✅ |
| Market history + price chart (MarketCollector + MarketChartView) | lib/market.js collector (service-only writer, reconcile EXECUTED/REFUNDED/confirm-window) + swapdb market_trades restored + ui.js canvas chart (native geometry/empty-states) + history rows/stats | ✅ 0.1.7 |

## OTC tab
| Native | MDS | Status |
|---|---|---|
| LP availability publish/withdraw, board, propose/counter/accept/reject/execute, deals list | otc.js + ui.js | ✅ |

## Background engine (service.js ↔ native SwapService)
| Native | MDS | Status |
|---|---|---|
| Taker settlement (claim/withdraw/refund, F1 confirm-from-chain) | settle.js | 📱 2 mainnet interop swaps (taker both directions, 2026-07-19) |
| Responder counter-legs (accept-gates, strict chain clock, record-before-broadcast) | responder.js | ✅ |
| Secret harvests (ETH preimage + notify state[100]) | settle.js (0.1.2) | ✅ |
| Peg oracle + keep-alive/reprice/tombstone | peg.js + maker.js | ✅ |
| Ladder BACKING CLAMP (e:177 checkLadderCoins — native REMOVED pre-splitting; clamp asks to the cumulative-backed prefix, fail-safe to 1) | maker.clampAsks at publish + order.trimAsks; dead splitCoins deleted | ✅ 0.1.7 |
| Doze keep-alive stack | ✖ n/a — MDS service lives as long as the node (platform difference) | ✖ |

## Platform-specific (no native equivalent required)
| Item | Status |
|---|---|
| WRITE-permission preflight + instruction card + self-healing boot (Classic trust model) | 📱 0.1.4/0.1.5 |
| lib/mdsw.js naming (node hijacks any *mds.js path) + browser-chain serving gate | 📱 0.1.5 |
