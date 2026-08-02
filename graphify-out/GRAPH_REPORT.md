# Graph Report - atomix-mds  (2026-07-29)

## Corpus Check
- 79 files · ~132,341 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 851 nodes · 1558 edges · 69 communities (60 shown, 9 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 38 edges (avg confidence: 0.57)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `328ab64d`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- ui.js
- app.js
- otc.js
- settle.js
- responder.js
- orderbook.js
- dependencies
- swapdb.js
- htlc.js
- rhino_sodium.js
- peg.js
- maker.js
- decimal.js
- browser_chain.js
- engine.js
- Rpc
- ethhtlc.js
- mdsw.js
- order.js
- ui_render.js
- hex.js
- run.js
- mds.js
- verify_vectors.js
- ax_sodium.js
- package.json
- abi.js
- ethtx.js
- rhino_eth.js
- ax_eth.js
- swapplan.js
- wallet.js
- service.js
- fmt.js
- trading.js
- otc.test.js
- boot.js
- flow.js
- ethtx.test.js
- settle.test.js
- inspect.js
- take.js
- boot.test.js
- build.sh
- rhino.sh
- PARITY — native AtomiX ↔ AtomiX MDS feature ledger

## God Nodes (most connected - your core abstractions)
1. `el()` - 39 edges
2. `render()` - 22 edges
3. `ccy()` - 16 edges
4. `esc()` - 16 edges
5. `swapTab()` - 14 edges
6. `norm()` - 14 edges
7. `orderEditor()` - 13 edges
8. `Rpc()` - 13 edges
9. `write()` - 13 edges
10. `read()` - 13 edges

## Surprising Connections (you probably didn't know these)
- `"node_modules/hash.js/lib/hash/sha/512.js"()` --indirect_call--> `el()`  [INFERRED]
  vendor/elliptic.js → lib/ui.js
- `scanChat()` --indirect_call--> `coins()`  [INFERRED]
  lib/otc.js → test/responder.test.js
- `lockMinimaCounterLeg()` --indirect_call--> `coins()`  [INFERRED]
  lib/responder.js → test/responder.test.js
- `"node_modules/bn.js/lib/bn.js"()` --indirect_call--> `start()`  [INFERRED]
  vendor/elliptic.js → lib/app.js
- `"node_modules/hash.js/lib/hash/sha/512.js"()` --indirect_call--> `start()`  [INFERRED]
  vendor/elliptic.js → lib/app.js

## Import Cycles
- None detected.

## Communities (69 total, 9 thin omitted)

### Community 0 - "ui.js"
Cohesion: 0.10
Nodes (67): activeSwap(), activityTab(), amtField(), banner(), bidiInput(), bootErrorCard(), ccy(), clean() (+59 more)

### Community 1 - "app.js"
Cohesion: 0.08
Nodes (56): armPulse(), attemptBoot(), axCsvCell(), axCsvRow(), axDirLabel(), axIso(), axIsTx(), axPickTx() (+48 more)

### Community 2 - "otc.js"
Cohesion: 0.13
Nodes (45): accept(), addMsg(), allDeals(), apply(), applyPropose(), approxEq(), changed(), claimExecute() (+37 more)

### Community 3 - "settle.js"
Cohesion: 0.13
Nodes (33): activeSwaps(), amountTokenOk(), broadcastEthRefund(), broadcastEthWithdraw(), checkCanSwapCoin(), checkEthContractBody(), checkEthContractFor(), checkExpiredMinima() (+25 more)

### Community 5 - "responder.js"
Cohesion: 0.14
Nodes (32): acceptTakerBuyMinima(), acceptTakerSellMinima(), addDec(), addIncoming(), cpBurstFull(), decimalsOf(), doScanIncoming(), ensureAllowance() (+24 more)

### Community 6 - "orderbook.js"
Cohesion: 0.11
Nodes (29): boxPkOf(), canonicalId(), fromSeed(), isValidPublicId(), makeIdentity(), open(), seal(), seedBytes() (+21 more)

### Community 7 - "dependencies"
Cohesion: 0.06
Nodes (31): blakejs, elliptic, esbuild, ethers, js-sha256, js-sha3, js-sha512, libsodium-wrappers (+23 more)

### Community 8 - "swapdb.js"
Cohesion: 0.20
Nodes (31): activeHashes(), allSwaps(), deleteSwap(), esc(), executedTrades(), getEvents(), getRequest(), getSecret() (+23 more)

### Community 9 - "htlc.js"
Cohesion: 0.16
Nodes (19): claim(), coinAmount(), deleteTxn(), grain(), loadKeys(), lock(), lockFromCoins(), maybeGrain() (+11 more)

### Community 10 - "rhino_sodium.js"
Cohesion: 0.09
Nodes (12): blake, hkdfSha256(), hmacSha256(), RFC-5869, nacl, { sha256 }, { sha512 }, fs (+4 more)

### Community 11 - "peg.js"
Cohesion: 0.15
Nodes (17): ingest(), poll(), price(), reconcileSpent(), ageMs(), applyPeg(), commitMexc(), effectiveLevel() (+9 more)

### Community 12 - "maker.js"
Cohesion: 0.20
Nodes (19): buildOrder(), clampAsks(), currentOrder(), doLoadConfig(), doPublish(), keepAlive(), kvKey(), loadConfig() (+11 more)

### Community 13 - "decimal.js"
Cohesion: 0.25
Nodes (19): bumpFrac(), ceilDp(), divFloor(), floorDp(), formatUnits(), fromScaled(), grain6(), gt0() (+11 more)

### Community 14 - "browser_chain.js"
Cohesion: 0.11
Nodes (16): collisions, ctx, dom, fails, fs, html, { JSDOM }, loadErrors (+8 more)

### Community 15 - "engine.js"
Cohesion: 0.25
Nodes (16): baseSwap(), confirmMyLock(), ensureAllowance(), ethChainNow(), executeOtc(), isMyPublishKey(), normKey(), notifyChanged() (+8 more)

### Community 16 - "Rpc"
Cohesion: 0.23
Nodes (5): big(), hexToBig(), host(), Rpc(), snippet()

### Community 17 - "ethhtlc.js"
Cohesion: 0.14
Nodes (4): b32(), contractId(), make(), safeBig()

### Community 18 - "mdsw.js"
Cohesion: 0.27
Nodes (12): cmd(), cmdR(), esc(), ethLockAcquire(), ethLockInit(), ethLockRelease(), kvDel(), kvGet() (+4 more)

### Community 19 - "order.js"
Cohesion: 0.24
Nodes (13): canonicalJson(), effectiveAsks(), effectiveBids(), finite(), fromJson(), hasLiquidity(), level(), make() (+5 more)

### Community 20 - "ui_render.js"
Cohesion: 0.15
Nodes (10): dom, fails, FILES, fs, { JSDOM }, me, nc, path (+2 more)

### Community 22 - "run.js"
Cohesion: 0.17
Nodes (10): ctx, fails, FILES, fs, nodeCrypto, path, ROOT, sandbox (+2 more)

### Community 23 - "mds.js"
Cohesion: 0.27
Nodes (5): httpPostAsync(), httpPostAsyncPoll(), MDSPostMessage(), PollListener(), postMDSFail()

### Community 24 - "verify_vectors.js"
Cohesion: 0.20
Nodes (8): { ethers }, fs, { hkdf }, seedBytes(), { sha256 }, sodium, unhex(), V

### Community 25 - "ax_sodium.js"
Cohesion: 0.27
Nodes (6): cat(), hkdfSha256(), hmacSha256(), RFC-5869, seal(), sealOpen()

### Community 26 - "package.json"
Cohesion: 0.20
Nodes (9): jsdom, dependencies, jsdom, description, name, private, scripts, test (+1 more)

### Community 27 - "abi.js"
Cohesion: 0.47
Nodes (9): decode(), encAddr(), encBool(), encBytes32(), encodeCall(), encUint(), pad64(), selector() (+1 more)

### Community 28 - "ethtx.js"
Cohesion: 0.33
Nodes (7): acquire(), busyErr(), doSend(), pump(), release(), send(), slot()

### Community 29 - "rhino_eth.js"
Cohesion: 0.38
Nodes (9): intToMinimalBytes(), { keccak256 }, keccakBytes(), rlpEncodeBytes(), rlpEncodeList(), rlpLenPrefix(), secp, signLegacyTx() (+1 more)

### Community 30 - "ax_eth.js"
Cohesion: 0.47
Nodes (8): addressFromPriv(), intBytes(), keccakBytes(), rlpBytes(), rlpLenPrefix(), rlpList(), signLegacyTx(), toBigHex()

### Community 31 - "swapplan.js"
Cohesion: 0.53
Nodes (8): buildSweepPlan(), ceilUsdt(), computeMinima(), computeUsdt(), legMinima(), num(), pstr(), sweepDepthMinima()

### Community 32 - "wallet.js"
Cohesion: 0.33
Nodes (5): checkSend(), gasReserveWei(), isEthAddr(), maxEthSendWei(), validDec()

### Community 33 - "service.js"
Cohesion: 0.56
Nodes (8): configureEngines(), getBalances(), log(), logOnce(), notifyLog(), poll(), reloadShared(), tryBoot()

### Community 34 - "fmt.js"
Cohesion: 0.38
Nodes (4): abbrev(), quoteOut(), trim6(), trimNum()

### Community 37 - "boot.js"
Cohesion: 0.60
Nodes (3): init(), lockedErr(), permErr()

### Community 38 - "flow.js"
Cohesion: 0.70
Nodes (4): each(), map(), once(), waterfall()

### Community 39 - "ethtx.test.js"
Cohesion: 0.60
Nodes (3): fakeRpc(), run(), runLock()

### Community 68 - "PARITY — native AtomiX ↔ AtomiX MDS feature ledger"
Cohesion: 0.20
Nodes (9): Activity tab, Background engine (service.js ↔ native SwapService), Market tab, OTC tab, PARITY — native AtomiX ↔ AtomiX MDS feature ledger, Platform-specific (no native equivalent required), Shell, Swap tab (+1 more)

## Knowledge Gaps
- **86 isolated node(s):** `Shell`, `Swap tab`, `Wallet tab`, `Activity tab`, `Market tab` (+81 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **9 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `"node_modules/hash.js/lib/hash/sha/512.js"()` connect `app.js` to `ui.js`, `elliptic.js`?**
  _High betweenness centrality (0.021) - this node is a cross-community bridge._
- **Why does `el()` connect `ui.js` to `app.js`?**
  _High betweenness centrality (0.019) - this node is a cross-community bridge._
- **What connects `Shell`, `Swap tab`, `Wallet tab` to the rest of the system?**
  _86 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `ui.js` be split into smaller, more focused modules?**
  _Cohesion score 0.09569798068481124 - nodes in this community are weakly interconnected._
- **Should `app.js` be split into smaller, more focused modules?**
  _Cohesion score 0.0768361581920904 - nodes in this community are weakly interconnected._
- **Should `otc.js` be split into smaller, more focused modules?**
  _Cohesion score 0.1276595744680851 - nodes in this community are weakly interconnected._
- **Should `settle.js` be split into smaller, more focused modules?**
  _Cohesion score 0.12660028449502134 - nodes in this community are weakly interconnected._