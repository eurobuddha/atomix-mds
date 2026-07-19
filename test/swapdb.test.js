/* swapdb — key normalisation, SQL-injection escaping, insertSecret idempotency, UPPERCASE row mapping. */
(function () {
    var DB = AX.swapdb;
    T.eq('norm strips 0x + lowercases', DB.norm('0xABCDef'), 'abcdef');
    T.eq('norm null → empty', DB.norm(null), '');

    var saved = globalThis.MDS;
    try {
        var queries = [], nextRows = [];
        globalThis.MDS = { sql: function (q, cb) {
            queries.push(q);
            if (/^\s*SELECT/i.test(q)) { var r = nextRows.shift(); cb({ status: true, rows: r || [] }); }
            else cb({ status: true });
        } };

        // insertSecret: ONE atomic idempotent statement (INSERT…WHERE NOT EXISTS); secret must be quote-escaped.
        queries.length = 0;
        DB.insertSecret('0xHASH', "ab'; DROP TABLE secrets;--", function (e) { T.ok('insertSecret ok', !e); });
        T.eq('insertSecret is a single statement', queries.length, 1);
        var ins = queries[0];
        T.ok('insertSecret INSERTs into secrets', /INSERT INTO `secrets`/.test(ins));
        T.ok('insertSecret is idempotent (WHERE NOT EXISTS)', /WHERE NOT EXISTS \(SELECT 1 FROM `secrets`/.test(ins));
        T.ok('insertSecret escapes quote (no bare quote injection)', ins.indexOf("ab''; DROP TABLE secrets;--") >= 0);
        T.ok('insertSecret normalises hash key (0x stripped, lowercased)', ins.indexOf("'hash'") >= 0 && ins.indexOf('0xHASH') < 0);

        // getSwap: UPPERCASE columns map to a typed swap object.
        nextRows = [[{
            HASH: 'abc', ROLE: 'INITIATOR', DIRECTION: 'ERC20_TO_MINIMA', SELLTOKEN: 'USDT', SELLAMOUNT: '5',
            BUYTOKEN: 'mxUSDT', BUYAMOUNT: '4.95', COUNTERPARTY: '0xmpk', STATUS: 'STARTED', CONTRACTID: '0xcid',
            MYTIMELOCK: '1700000000', MYLEGMINIMA: '0', CREATED: '111', UPDATED: '222'
        }]];
        DB.getSwap('0xABC', function (e, s) {
            T.ok('getSwap non-null', !!s);
            T.eq('getSwap maps fields', [s.role, s.direction, s.buyAmount, s.contractId], ['INITIATOR', 'ERC20_TO_MINIMA', '4.95', '0xcid']);
            T.eq('getSwap mylegminima 0 → false', s.myLegIsMinima, false);
            T.eq('getSwap timelock numeric', s.myTimelock, 1700000000);
        });

        // upsertSwap emits a MERGE with the normalised key + numeric timelock/legminima inlined safely.
        queries.length = 0;
        DB.upsertSwap({ hash: '0xDEAD', role: 'INITIATOR', direction: 'MINIMA_TO_ERC20', sellToken: 'mxUSDT',
            sellAmount: '1.5', buyToken: 'USDT', buyAmount: '1.485', counterparty: '0xe', status: 'STARTED',
            contractId: '', myTimelock: 1144, myLegIsMinima: true, created: 100 }, function (e) { T.ok('upsertSwap ok', !e); });
        var up = queries[0];
        T.ok('upsertSwap MERGE', /MERGE INTO `swaps`/.test(up));
        T.ok('upsertSwap key normalised', up.indexOf("'dead'") >= 0);
        T.ok('upsertSwap legminima → 1', /,1,/.test(up.replace(/\s/g, '')) || up.indexOf(',1,') >= 0);

        // activeHashes excludes terminal statuses.
        nextRows = [[{ HASH: 'a' }, { HASH: 'b' }]];
        DB.activeHashes(function (e, hs) { T.eq('activeHashes', hs, ['a', 'b']); });
        T.ok('activeHashes filters terminal', /NOT IN \('COMPLETE','REFUNDED','ERROR'\)/.test(queries[queries.length - 1]));
    } finally { globalThis.MDS = saved; }
})();
