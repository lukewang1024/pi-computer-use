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

Before each HID event, the helper reads modifier flags and left/right modifier
key state from both HID and combined-session state. An already held modifier
outside the current action rejects input with `modifier_state_unverified`.
Unexpected modifiers appearing after dispatch stop the sequence with
`modifier_interrupted_after_partial_hid`, retain outstanding key diagnostics,
and require recovery without replay. The helper does not release unrelated
modifiers or infer ownership from an earlier action.
