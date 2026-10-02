# v0.5.2-workbench.4

> Windows foreground activation and capture reliability update for Workbench.

## Features

- Restore minimized Windows targets and confirm exact HWND foreground identity after bounded activation attempts.
- Diagnose owner chains, GUI threads and interactive desktop availability; reject physical input when identity or desktop cannot be confirmed.
- Retry transient capture failures after restoration, refresh geometry and read unselected GDI bitmaps.

## Changelog

- Remove synthetic foreground selection from the first enumerated Windows root.
- Run optional UIA activation in a bounded child process; fence input after uncertain completion.
- Reject stale UIA and unknown occlusion rather than using cached coordinates.
- Gate screen-pixel capture on exact foreground identity before and after reading.
- Keep physical input out of native unit tests.

The internal release retains the unchanged macOS and Linux prebuilt helpers from the exact v0.5.2-workbench.3 deployment package and rebuilds the Windows helper from this source.
