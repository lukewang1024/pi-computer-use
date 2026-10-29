> Recover transaction-owned input independently of the old foreground window.

## Fixes

- Separate error cleanup from admission of new HID input. Release only this transaction's acquired keys/buttons, preserve unrelated modifiers, and verify system input state without replaying the action.
- Persist private write-ahead input journals with distinct prepared and acknowledged events, so evidence survives a helper exit.
- Add a managed up-only recovery command under a quarantined native maintenance fence. Verify helper identity, process shutdown, boot, queue epoch, release scope and neutral OS input before returning recovery proof.
- Support explicit scoped repair of legacy incidents without fabricating input ownership or requiring a human key-release confirmation.

## Validation

- Cover owned cleanup, foreign modifiers, journal I/O failure, incomplete input samples, native maintenance admission, stale ownership and rejected recovery receipts without posting OS input.
- Live recovery and managed deployment results are recorded separately from source and package checks.
