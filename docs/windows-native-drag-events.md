# Windows native drag event ordering

Native drag queues the initial absolute position, one left-button press, all
remaining path positions, and one release in a single `SendInput` call. The release also carries the
absolute final path coordinates and the MOVE flag, so its position does not
depend only on a separate preceding move message. Path
moves use `MOUSEEVENTF_MOVE_NOCOALESCE` and absolute virtual-desktop coordinates,
including monitors with negative origins.

Previously, cursor moves used `SetCursorPos` between separately queued button
events. A native PowerPoint trial, with the rectangle tool selected by a physical
click in its owned palette, produced the default one-inch square rather than
the requested bounds. A first atomic-queue candidate improved this to a
rectangle ending near the middle path point; it still failed the endpoint
check. Binding release coordinates is a follow-up candidate, not a verified
application fix. UIA Invoke on the shape palette itself inserts a default-size
shape without entering mouse drawing mode, so it is not a valid drag setup.

Every observed HWND/PID pointer check still runs before dispatch. Invalid desktop
geometry or any out-of-desktop point rejects the complete plan before input.
Existing foreground, interactive-desktop, stale-reference and uncertain-input
rules are unchanged. A returned dispatch is not proof of the application effect;
verify the resulting pixels or saved shape geometry without replaying input.

Local tests cover ordered button transitions, path endpoints, negative monitor
origins and pre-dispatch geometry rejection. Native PowerPoint geometry
verification is required on the exact CI candidate before release.

References: Microsoft's [MOUSEINPUT flags](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-mouseinput)
and [SendInput ordering contract](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput).
