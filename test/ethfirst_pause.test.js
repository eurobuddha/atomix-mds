// Security review 7 Nov 2026: HTLC v1.2 cannot require a 32-byte secret, so makers ship with ETH-first buys PAUSED.
T.ok('ETH-first buys ship paused until HTLC v1.3', AX.htlc.ETH_FIRST_PAUSED === true);
