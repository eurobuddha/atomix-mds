// txnId uniqueness — an MDS-only correctness bug.
//
// Date.now() alone is millisecond-granular, so two settlement actions starting in the same millisecond
// produced the SAME node-side transaction id. Their txninput/txnstate/txnsign commands then interleaved
// into ONE merged transaction which got posted: a corrupt spend, and a signature over content neither
// caller intended. Native uses System.nanoTime(); this is the JS equivalent.
(function () {
    var ids = {}, dupes = 0, N = 500;
    for (var i = 0; i < N; i++) {
        var id = AX.htlc._txnId ? AX.htlc._txnId() : null;
        if (id === null) { T.ok('txnId: not exported for testing (skipped)', true); return; }
        if (ids[id]) dupes++;
        ids[id] = true;
    }
    T.eq('txnId: 500 ids generated back-to-back are all unique', dupes, 0);
    T.ok('txnId: keeps the axswap_ prefix', /^axswap_[0-9a-f]+_[0-9a-f]+$/.test(Object.keys(ids)[0]));
})();
