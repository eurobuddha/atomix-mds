/* mdsw — a declined node command surfaces the node's OWN reason (send.java puts it under `message`, not `error`). */
(function () {
    var M = AX.mds, saved = globalThis.MDS;
    try {
        globalThis.MDS = { cmd: function (c, cb) { cb({ status: false, message: 'Insufficient funds.. you only have 0 require:0.000000001' }); } };
        var got = null; M.cmdR('send address:0xAA amount:1', function (e) { got = e; });
        T.ok('message-only refusal is rendered verbatim', got && /Insufficient funds\.\. you only have 0/.test(got.message) && got.message.indexOf('undefined') < 0);
        globalThis.MDS = { cmd: function (c, cb) { cb({ status: false, error: 'Transaction not found : x' }); } };
        M.cmdR('txnsign id:x publickey:auto', function (e) { got = e; });
        T.ok('error field still wins when present', got && /Transaction not found : x/.test(got.message));
        globalThis.MDS = { cmd: function (c, cb) { cb({ status: false }); } };
        M.cmdR('coins', function (e) { got = e; });
        T.ok('a bare refusal says so instead of "undefined"', got && /no reason given/.test(got.message));
    } finally { globalThis.MDS = saved; }
})();
