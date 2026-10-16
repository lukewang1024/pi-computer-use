# Windows native drag event delivery

The candidate sends absolute virtual-desktop positioning, one left-button press,
all path positions, and one release carrying the final coordinates. Each event
is injected separately with a 16ms processing interval before the next event.
Paths are bounded to 2–600 points before input, so the pacing budget is bounded.
Moves use `MOUSEEVENTF_MOVE_NOCOALESCE` and support monitors with negative origins.

A native PowerPoint trial, with the rectangle tool selected by a physical click
in its owned palette, produced the default one-inch square on the released
implementation. Two atomic-queue candidates reached only the middle path point,
even when release carried final coordinates. The paced candidate allows the app
to process down/move messages before release; it still requires native geometry
verification. These observations do not prove the precise internal Office cause.
UIA Invoke on the shape palette inserts a default-size shape without entering
mouse drawing mode, so it is not valid setup for a drag acceptance trial.

All observed HWND/PID path checks run before dispatch. Every emitted event also
rechecks the exact foreground window, interactive desktop and pointer hit target.
A failed check stops the sequence without another event. If events were already
sent, the original partial-HID contract reports their count, held left button,
`recoveryRequired=true` and `retrySafe=false`; no release is sent to an unverified
new foreground target and the gesture must not be replayed. Rejection before any
event returns the normal error. Existing stale-reference guards remain intact.

The completion diagnostic includes requested endpoint, observed cursor position
when available, sent-event count and elapsed time. None of these prove the app
created the intended shape: verify pixels and saved geometry.

Tests cover event order and endpoints, negative monitor origins, invalid geometry,
initial rejection, and interruption after button-down without further delivery.
Native PowerPoint verification on the exact CI package is required before release.

References: Microsoft's [MOUSEINPUT flags](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-mouseinput)
and [SendInput ordering contract](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput).
