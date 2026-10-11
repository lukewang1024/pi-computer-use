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
# Popup reference identity

Popup menu actions require the exact cached live AX element. An item in an
unopened submenu may appear in an outline with zero geometry; this does not
authorize selecting it through a replacement element. Expand the parent menu,
observe again, and use the new current reference. Changed item labels or shared
action identifiers cannot establish identity. Stale popup refs stop before input.

For other native controls that permit semantic refinding, role, any observed
identifier and any observed label must agree, and exactly one candidate must
remain. Distance does not resolve ambiguous aliases. Dispatch receipts still
require independent effect verification; menu invocation is never retried after
an unknown effect.
