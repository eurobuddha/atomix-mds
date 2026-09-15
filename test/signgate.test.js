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

    // A long elapsed hold is not evidence that the node stopped signing.
    var savedNow = Date.now, held = null, delayed = [];
    try {
        Date.now = function () { return 1000000; };
        G.submit(function (release) { held = release; delayed.push('first'); });
        Date.now = function () { return 2000000; };
        G.submit(function (release) { delayed.push('second'); release(); });
        T.eq('signgate: elapsed time cannot dispatch overlapping signatures', delayed, ['first']);
        held();
        T.eq('signgate: real callback safely drains delayed work', delayed, ['first', 'second']);
    } finally { Date.now = savedNow; }

    // ---- a synchronous throw must not latch the gate ----
    // The one case where a hold can be freed safely: op threw before issuing anything, so no signature is in
    // flight and no callback is coming. Previously this left busy=true forever and every later claim, refund
    // and publish queued behind it in silence until the app restarted.
    var ran = [], threw = false;
    try {
        G.submit(function (release) { ran.push('boom'); throw new Error('cmd shim failed before the node'); });
    } catch (e) { threw = true; }
    T.ok('signgate: a synchronous throw still reaches the caller', threw);
    T.eq('signgate: the throwing op did run', ran, ['boom']);
    // The gate must be open again: this op runs immediately, not "never".
    G.submit(function (release) { ran.push('after throw'); release(); });
    T.eq('signgate: a synchronous throw does not wedge the queue', ran, ['boom', 'after throw']);
    T.eq('signgate: queue empty after the throw recovery', G._pending(), 0);

    // ---- multisig ----
    // `multisig action:sign` signs, but starts with neither 'sign' nor 'send', so prefix matching used to
    // miss it entirely. AtomiX never calls it; listed so the gate stays honest for any host that does.
    T.ok('signgate: multisig is a signing command', G.signs('multisig action:sign file:x.txn'));
    T.ok('signgate: multisig create is gated too', G.signs('multisig action:create id:x amount:1'));

    // ---- the queue survives an operation that never releases ----
    // A hold with no callback pending blocks everything behind it, and that is the DELIBERATE trade: elapsed
    // time cannot tell a lost callback from a slow one (the node's own write timeout is 180s), and freeing a
    // hold whose signature is still in flight would issue two signatures on one leaf — the exact key-leaking
    // bug this module exists to stop. A wedged gate costs a missed claim; a wrong release costs the key.
    var after = [];
    G.submit(function (release) { after.push('dead'); /* never releases */ });
    G.submit(function (release) { after.push('blocked'); release(); });
    T.eq('signgate: a live hold still blocks the next op', after, ['dead']);
})();
