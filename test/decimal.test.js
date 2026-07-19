/* Exact decimal math (no float error): grain, floor/ceil, mul/div, parseUnits/formatUnits. */
(function () {
    var D = AX.dec;
    T.eq('grain6 floors DOWN', D.grain6('4.9505009'), '4.9505');   // trailing zeros stripped after truncation
    T.eq('grain6 truncate 8th place', D.grain6('1.234567891'), '1.234567');
    T.eq('grain6 integer', D.grain6('30'), '30');
    T.eq('floorDp keeps', D.floorDp('0.99', 6), '0.99');
    T.eq('ceilDp bumps on remainder', D.ceilDp('4.9504951', 6), '4.950496');
    T.eq('ceilDp exact no bump', D.ceilDp('5.000000', 6), '5');
    // sell 4.95 @ 0.99 → 4.9005 (floor); buy 5 @ 1.01 → 4.950495 (floor); pay 4.950495 @ 1.01 ceil → 5
    T.eq('mulFloor sell proceeds', D.mulFloor('4.95', '0.99', 6), '4.9005');
    T.eq('divFloor buy receive', D.divFloor('5', '1.01', 6), '4.950495');
    T.eq('mulCeil pay', D.mulCeil('4.950495', '1.01', 6), '5');
    T.eq('mul no float error', D.mulFloor('0.1', '0.2', 18), '0.02');   // classic 0.1*0.2 float trap
    // parseUnits / formatUnits (ETH scale)
    T.eq('parseUnits usdt 6dp', D.parseUnits('5', 6).toString(), '5000000');
    T.eq('parseUnits req 18dp', D.parseUnits('4.950495', 18).toString(), '4950495000000000000');
    T.eq('parseUnits truncates extra', D.parseUnits('1.9999999', 6).toString(), '1999999');
    T.eq('formatUnits back', D.formatUnits(5000000n, 6), '5');
    T.eq('formatUnits fractional', D.formatUnits(4950495000000000000n, 18), '4.950495');
})();
