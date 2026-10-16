# Windows native drag event ordering

Native drag queues the initial absolute position, one left-button press, all
remaining path positions, and one release in a single `SendInput` call. Path
moves use `MOUSEEVENTF_MOVE_NOCOALESCE` and absolute virtual-desktop coordinates,
including monitors with negative origins.

Previously, cursor moves used `SetCursorPos` between separately queued button
events. A native PowerPoint rectangle-drawing trial produced its default
one-inch square instead of the requested drag bounds. Keeping motion and button
events in the same ordered input stream addresses that delivery gap.

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
