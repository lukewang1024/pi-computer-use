# macOS application menus

Use `observe_ui` with the exact native window root, `mode: "semantic"`, and
`applicationMenu: true` to include its application's observed top-level menu bar.
The target window must already be the application's focused foreground window.
The helper checks the window's owner and the current menu bar's AX identity again
after collecting the outline. Ordinary observations are unchanged.

Only currently observed top-level items receive refs. Hidden submenu contents
are not included. An item supports explicit `invoke` only when its current owner,
menu-bar ancestry, enabled state and declared `AXPress` are verified. Application
menu refs do not authorize pointer or keyboard fallback. A same-process floating
window is not sufficient: the exact observed window must still be focused.

After invoking a menu item once, observe the resulting popup through the existing
native root and popup pairing interface. A returned AX action does not prove the
application effect; check the new visible state. Never replay an unknown result.
Missing, replaced or stale menu refs require a fresh observation. Helpers that do
not acknowledge this observation capability are rejected rather than silently
returning a window-only outline.
