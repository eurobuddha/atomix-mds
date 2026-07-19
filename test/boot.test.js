/* boot — the Classic first-run permission preflight (the bug the FIRST real-node install hit):
   MiniDapps install with READ trust by default; AtomiX needs WRITE (vault/seedrandom/newscript/txn*).
   checkmode fails fast with a SPECIFIC error; the pending belt catches it when checkmode is unavailable. */
(function () {
    var saved = globalThis.MDS;
    function hex(n, b) { return '0x' + b.repeat(n); }

    /** Build an MDS mock: overrides = { checkmode, vault, seedrandom } full-result objects. */
    function mockMds(o) {
        return {
            cmd: function (c, cb) {
                if (c.indexOf('checkmode') === 0) return cb(o.checkmode || { status: false, error: 'unknown command' });
                if (c.indexOf('random size:64') === 0) return cb({ status: true, response: { random: hex(64, 'ab') } });
                if (c.indexOf('random size:8') === 0) return cb({ status: true, response: { random: hex(8, 'cd') } });
                if (c.indexOf('vault') === 0) return cb(o.vault || { status: false, error: 'no vault stub' });
                if (c.indexOf('seedrandom') === 0) return cb(o.seedrandom || { status: false, error: 'no seedrandom stub' });
                if (c.indexOf('newscript') === 0) return cb({ status: true, response: {} });
                if (c.indexOf('getaddress') === 0) return cb({ status: true, response: { miniaddress: 'MxTEST', address: '0xADDR', publickey: '0xPUB' } });
                cb({ status: true, response: [] });
            },
            sql: function (q, cb) { cb({ status: true, rows: [] }); }
        };
    }

    try {
        // (A) checkmode reports READ → fail fast with err.permission (the instruction-card trigger).
        globalThis.MDS = mockMds({ checkmode: { status: true, response: { mode: 'READ', writemode: false, dblocked: false } } });
        AX.boot.init(function (err) {
            T.ok('READ mode → permission error', err && err.permission === true);
            T.ok('READ mode → says WRITE permission', err && /WRITE permission/.test(err.message));
        });

        // (B) checkmode reports a password-locked vault → distinct locked error.
        globalThis.MDS = mockMds({ checkmode: { status: true, response: { mode: 'WRITE', writemode: true, dblocked: true } } });
        AX.boot.init(function (err) {
            T.ok('dblocked → locked error (not permission)', err && err.locked === true && !err.permission);
        });

        // (C) BELT: checkmode unavailable + vault comes back pending:true (READ trust queued it) → permission error.
        globalThis.MDS = mockMds({ vault: { status: false, pending: true, response: null } });
        AX.boot.init(function (err) {
            T.ok('pending vault (no checkmode) → permission error', err && err.permission === true);
        });

        // (D) WRITE mode + real responses → boot completes with identities + a derived ETH address.
        globalThis.MDS = mockMds({
            checkmode: { status: true, response: { mode: 'WRITE', writemode: true, dblocked: false } },
            vault: { status: true, response: { seed: hex(32, '11') } },
            seedrandom: { status: true, response: { seedrandom: hex(32, '22') } }
        });
        AX.boot.init(function (err, ctx) {
            T.ok('WRITE mode → boot succeeds', !err && !!ctx);
            T.ok('boot derived both currency identities', ctx && !!ctx.identities.minima && !!ctx.identities.mxusdt);
            T.ok('boot derived the ETH address', ctx && /^0x[0-9a-f]{40}$/i.test(ctx.eth.address));
            T.eq('boot captured the HTLC identity key', ctx && ctx.htlc.publickey, '0xPUB');
        });
    } finally {
        globalThis.MDS = saved;
        AX.ethtx.useLock(null, null);   // test D's boot wired the CAS lock to the mock MDS — unwire for later suites
    }
})();
