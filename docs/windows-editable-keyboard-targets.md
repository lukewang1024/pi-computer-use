# Windows editable keyboard targets

An explicit editable element reference targets that editor for `typeText` and
`keypress`, including controls hosted in Chromium windows. The native helper
requires the exact live UIA runtime identity to hold keyboard focus before
sending input. It may focus that exact editor once; if focus cannot be verified,
it refuses the key without clicking or falling back to the currently focused
control. The exact foreground HWND and process must still match.

A window-root key remains a window command. A successful `setText` value
observation does not prove that an application has committed the value; verify
the intended effect after Enter or another explicit commit action.

Automatic action screenshots are capped at 900 pixels. Explicit observations
can be larger; use each observation's current coordinate frame rather than
reusing points from a differently sized image.
