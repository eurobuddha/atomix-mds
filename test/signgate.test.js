// signgate — only one signing command in flight at a time.
//
// Signing one Minima key concurrently makes the node issue the SAME one-time leaf for two different
// messages, which leaks that leaf's private key. Confirmed on a live node: 7 of 64 default keys.

(function () {
    var G = AX.signgate;

    // ---- which commands are treated as signing ----

    T.ok('signgate: send is a signing command', G.signs('send amount:1 address:Mx00'));
    T.ok('signgate: txnsign is a signing command', G.signs('txnsign id:x publickey:auto'));
    T.ok('signgate: sign is a signing command', G.signs('sign publickey:0x00 data:0x00'));
    T.ok('signgate: consolidate is a signing command', G.signs('consolidate tokenid:0x00'));
    T.ok('signgate: tokencreate is a signing command', G.signs('tokencreate name:x amount:1'));

    // Reads must NOT be gated — serialising them would slow the whole app for no safety gain.
    T.ok('signgate: balance is not gated', !G.signs('balance'));
    T.ok('signgate: coins is not gated', !G.signs('coins relevant:true'));
    T.ok('signgate: block is not gated', !G.signs('block'));
    T.ok('signgate: txnlist is not gated', !G.signs('txnlist'));
    T.ok('signgate: null is not gated', !G.signs(null));

    // `sendpoll` starts with "send" but is a different command; documenting current behaviour — it is
    // gated, which is harmless (it is rare and signing-adjacent) but worth knowing.
    T.ok('signgate: leading whitespace still matches', G.signs('  send amount:1 address:Mx00'));

    // ---- serialisation ----

    var log = [];
    var relA = null, relB = null, relC = null;

    G.submit(function (release) { log.push('start A'); relA = release; });
    // B must NOT have started while A holds the gate — that overlap is the entire bug.
    T.eq('signgate: second op waits for the first', log, ['start A']);

    G.submit(function (release) { log.push('start B'); relB = release; });
    T.eq('signgate: B still queued while A holds', log, ['start A']);

    log.push('end A'); relA();
    T.eq('signgate: releasing A starts B', log, ['start A', 'end A', 'start B']);

    // Releasing twice must not pull an extra operation off the queue.
    G.submit(function (release) { log.push('start C'); relC = release; });
    relB(); relB(); relB();
    T.eq('signgate: release is idempotent', log, ['start A', 'end A', 'start B', 'start C']);

    relC();

    // ---- never two at once, across a burst ----

    var openCount = 0, maxOpen = 0, rels = [];
    for (var i = 0; i < 8; i++) {
        G.submit(function (release) { openCount++; if (openCount > maxOpen) maxOpen = openCount; rels.push(release); });
    }
    T.eq('signgate: only one of eight runs at a time', maxOpen, 1);
    while (rels.length) { openCount--; rels.shift()(); }
    T.eq('signgate: queue drains completely', G._pending(), 0);

    // ---- the queue survives an operation that never releases ----
    // No timers exist in the Rhino service context, so the stale-hold check is lazy: it runs when the
    // NEXT operation is submitted. Here the dead hold is recent, so the next op must still wait.
    var after = [];
    G.submit(function (release) { after.push('dead'); /* never releases */ });
    G.submit(function (release) { after.push('blocked'); release(); });
    T.eq('signgate: a live hold still blocks the next op', after, ['dead']);
})();
