# Linux X11 window association

AT-SPI frames are associated with X11 windows only when the process ID is known
and equal, original geometries are close enough to account for window manager
decorations, and both sides uniquely select each other. Titles rank candidates
inside that geometry gate. Missing geometry, ambiguous candidates and distant
same-process windows remain unassociated rather than borrowing another window's
accessibility tree.

An unmatched X11 window with a known process ID and valid geometry is exposed
as a pixel-only root. Its metadata reports `backend: "x11"` and
`accessibilityAvailable: false`; observation has no semantic element references
or actions. Coordinate interaction still requires a fresh observation and the
existing exact-window foreground and hit-test guards. Physical input additionally
checks the live X11 process ID before activation and before each input preflight;
a missing or changed process ID rejects the action as stale.

This does not add native Wayland input or eliminate the AT-SPI connection
requirement. File chooser completion and upload correctness require separate
managed desktop acceptance, including an independent file-content oracle.
