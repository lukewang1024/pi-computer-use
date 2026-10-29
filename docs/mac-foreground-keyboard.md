# macOS native keyboard foreground policy

Native `typeText` and `keypress` in interactive mode now request the existing
exact-window foreground gate before their first dispatch, including ref-grounded
actions. Previously those refs selected background PID events, which some native
views can ignore even when the transport returns normally. An unknown result is
never a reason to resend input.

This uses the existing native PID/window/focus gate and HID delivery; it does not
relax disabled-control, stale-ref, current-state or exact-window checks. Semantic
AX value writes, native AXPress, strict headless, browser CDP actions and the
Windows/Linux routing keep their existing policy. A refused foreground transition
must still stop before physical input. Real dialog, competing-window and native
editor regressions are required before deploying this SDK candidate.

Physical key chords press their requested modifiers explicitly, release the base
key, then release those modifiers in reverse order. Each event independently
passes the exact-window gate. Key-up flags describe modifiers that are still
held; releasing a base key does not by itself prove that Control was released.
macOS reports modifier transitions as
[flags-changed events](https://developer.apple.com/documentation/coregraphics/cgeventtype/flagschanged).

Before a physical chord, Unicode key pair, click or drag, the helper checks the
requested keys/buttons in both HID and combined-session state. A pre-held input
is refused without taking ownership or sending a release for the user's input.
After posting releases it verifies the same state tables, with at most four
read-only samples separated by 8 ms when still held. This uses the current
[Quartz key state](https://developer.apple.com/documentation/coregraphics/cgeventsource/keystate(_:key:)),
not just the helper's emitted-event ledger. Verification never reposts input.

An unconfirmed release returns unknown partial-HID delivery, possibly held
key/button codes and `recoveryRequired: true`, `retrySafe: false`. An unexpected
allocation, AX or other error after physical dispatch receives the same partial
delivery contract; it cannot be reported as a zero-input refusal merely because
its error type was not anticipated. Before any dispatch, the original refusal
contract remains unchanged. No successor state or later action is issued after
unknown delivery.

The SDK and Executor recognize partial-HID dispatch evidence independently of
the diagnostic error code. The public SDK retains the existing foreground
quarantine code for generic partial-HID failures so older Executors still stop;
the exact native cause remains in `execution.error`. Observed possibly held
inputs are diagnostic evidence, not authority to release a key or button into a
different foreground window. Process crashes and lost transport still require
the existing explicit recovery protocol, with no automatic action replay.

Before each HID event, the helper reads modifier flags and left/right modifier
key state from both HID and combined-session state. An already held modifier
outside the current action rejects input with `modifier_state_unverified`.
Unexpected modifiers appearing after dispatch stop the sequence with
`modifier_interrupted_after_partial_hid`, retain outstanding key diagnostics,
and require recovery without replay. The helper does not release unrelated
modifiers or infer ownership from an earlier action.

Modifier chords require a base key with an actual native key-code mapping.
An unmapped chord such as `cmd+🙂` is rejected before any action in the
transaction is sent, rather than falling back to inserting plain text without
the requested modifier. Printable ASCII symbols use their native base key and
implied Shift, so `cmd+?` and `["cmd", "+"]` retain the
requested Command modifier while pressing Shift with `/` or `=` respectively.
Unmodified Unicode key input retains its existing
behavior; use `typeText` for text insertion.

If a chord opens a sheet, remaining key releases may pass a separate bounded
release check: both fresh AX samples must identify the same sheet with the
exact original AX window as its direct parent, the same uniquely mapped CG
window and stable foreground PID. The original window must remain main. Only
keys held by this transaction may be released, with precisely the remaining
modifier flags. This does not authorize new key-down, mouse or text events,
other same-process windows, or releasing keys from a previous failed action.

If the two observations straddle the original-window to direct-sheet transition,
only a pending transaction-owned key release can request up to two further
read-only samples. The transition sample does not permit HID dispatch. A fresh
stable owned-sheet proof is still mandatory before releasing the key.

Some applications open a separate top-level panel rather than an AXSheet. A
transaction records a complete same-process CG window inventory before dispatch,
including hidden windows. Its remaining owned key-ups may reach a newly created
window only when two fresh native focus mappings identify that exact window in
the same foreground process, both current inventories contain it and the source
window, and it was absent before dispatch. Missing inventories, pre-existing
windows, changed processes and mixed focus samples do not authorize a release.
A mixed source-to-new-window sample permits only another bounded read. This rule
does not authorize new key-downs, pointer events or keys from an earlier action.
