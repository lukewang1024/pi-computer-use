# macOS browser editing commands

The original referenced-keypress path attaches Chromium `SelectAll` to the
existing keydown for exactly macOS Meta/Command+A. Modifier bits alone can
deliver trusted events without applying Cocoa editing bindings. The original
keydown/keyup pair, target focus, captured state and unknown-result guards remain
required. There is no second command dispatch or fallback input.

This mapping does not alter Windows/Linux Ctrl+A, add clipboard commands, or
prove selection by acknowledgement. Verify the exact selection range and sibling
state, then independently verify any replacement text and trusted input events.
Native Word and macOS select popup menus are separate paths.

Reference: [Chromium maintainer explanation](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/3033).
