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
