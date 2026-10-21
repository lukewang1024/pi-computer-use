# v0.5.2-workbench.136

The virtual agent pointer now follows the supplied Codex cursor reference, with
a black arrow, a rounded white outline, and a soft blue halo.

## Features

- Use the same compact artwork in browser, macOS, Windows, and Linux X11 overlays.

## Changelog

- Adjust the arrow contour, outline thickness, and blue halo falloff.
- Preserve the 19 × 20 logical-unit canvas, (2, 1) hotspot, fixed orientation,
  input transparency, and existing animation and idle cleanup.
- Update X11 acceptance to check the black arrow and exact endpoint using the
  configured hotspot, including halo padding when compositing is available.
- Wait for the test window and window-manager focus to settle before measuring
  renderer focus preservation, and require the requested compositing path.

> Don't panic.
