# Native standard floating windows

Some applications expose floating tool windows as AXWindow/AXStandardWindow
rather than a dialog subrole. For example, Word Go To can open Find and Replace
in this form. The previous layer-zero title-ranked mapping could assign a
neighboring CG window ID, while exact foreground verification found the actual
floating window and correctly refused input.

The native mapper now admits a nonzero-layer window only when readable AX
geometry, compatible nonempty titles, visible CG ownership and two-way unique
matching establish its identity. The proof considers the full supplied AX/CG
inventory, including other geometrically matching windows that are ineligible
for this added path. Duplicate, conflicting, offscreen, moved or unreadable
candidates do not obtain this mapping. Confidence is high, not an invented exact
title match. Foreground verification, disabled-control checks, state references
and uncertain-input handling remain unchanged.
