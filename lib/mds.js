/**
 * mdsx — callback-style wrappers over the MDS bridge (MDS.cmd / MDS.sql / MDS.net) + a kv store. Callback (not
 * promise) based to match the proven donor and stay reliable under Rhino (no event loop). Attaches to AX.mds.
 * In the Node test harness g.MDS is a mock; on a node it is the real MDS object.
 *
 * Node command responses: {status, pending, response, error}. A vault-locked node returns pending:true on WRITE
 * commands — treated as "accepted/queued" (the coin may not mine; a book-presence belt handles that later).
 */
(function (g) {
    'use strict';
    var AX = g.AX = g.AX || {};

    /** cmd(command, cb(fullResult)). */
    function cmd(command, cb) { g.MDS.cmd(command, function (r) { cb(r); }); }

    /** cmdR(command, cb(err, response)) — err is null on status:true OR pending:true. */
    function cmdR(command, cb) {
        g.MDS.cmd(command, function (r) {
            if (r && (r.status === true || r.pending === true)) cb(null, r.response, r);
            else cb(new Error('cmd failed: ' + command + ' — ' + (r && r.error)), null, r);
        });
    }

    function sql(query, cb) { g.MDS.sql(query, function (r) { cb(r); }); }
    function netGet(url, cb) { g.MDS.net.GET(url, function (r) { cb(r); }); }
    function netPost(url, data, cb) { g.MDS.net.POST(url, data, function (r) { cb(r); }); }

    /** MDS.net response body may be a string, a base64 blob, or already-parsed (donor pattern). */
    function netText(res) {
        if (!res || res.response == null) return null;
        var r = res.response;
        if (typeof r === 'string') return r;
        if (typeof r === 'object' && r.data) { try { return g.atob ? g.atob(r.data) : r.data; } catch (e) { return null; } }
        try { return JSON.stringify(r); } catch (e) { return null; }
    }

    // ---- kv store: a single SQL table (both hosts share it; SharedPreferences equivalent) ----
    // Writes surface a failure (err) so a silent persistence loss of e.g. trading_currency can't hide.
    function kvInit(cb) {
        sql("CREATE TABLE IF NOT EXISTS `ax_kv` (`k` varchar(200) NOT NULL PRIMARY KEY, `v` text NOT NULL)", function (r) { cb && cb(sqlErr(r)); });
    }
    function kvGet(key, dflt, cb) {
        sql("SELECT v FROM ax_kv WHERE k='" + esc(key) + "'", function (r) {
            cb((r && r.status && r.rows && r.rows.length) ? r.rows[0].V : (dflt === undefined ? null : dflt));
        });
    }
    function kvSet(key, val, cb) {
        sql("MERGE INTO ax_kv (k, v) KEY(k) VALUES ('" + esc(key) + "', '" + esc(String(val)) + "')", function (r) { cb && cb(sqlErr(r)); });
    }
    function kvDel(key, cb) { sql("DELETE FROM ax_kv WHERE k='" + esc(key) + "'", function (r) { cb && cb(sqlErr(r)); }); }

    function sqlErr(r) { return (r && r.status) ? null : new Error('sql failed: ' + (r && r.error)); }

    /** SQL string escaper (single-quote doubling) — every value that reaches a query MUST pass through this. */
    function esc(s) { return String(s).split("'").join("''"); }

    AX.mds = {
        cmd: cmd, cmdR: cmdR, sql: sql, netGet: netGet, netPost: netPost, netText: netText,
        kvInit: kvInit, kvGet: kvGet, kvSet: kvSet, kvDel: kvDel, esc: esc
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
