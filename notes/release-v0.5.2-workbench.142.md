> Balance owned keyboard chords when an application opens a new top-level panel.

## Fixes

- Record a complete pre-dispatch window inventory, including hidden windows, to distinguish a newly created same-app panel from unrelated existing windows.
- Permit only the current transaction's remaining key-ups after two exact native focus and window-inventory checks; a mixed transition requests another bounded read.
- Keep unknown delivery, input-state verification and quarantine intact when the release cannot be proved. Never replay the shortcut or release input owned by an earlier action.

## Validation

- Cover supported chord shapes, partial-input cleanup, missing inventories, existing windows, foreground races and rejection of new keyboard or pointer input.
- Validate native compilation and the SDK checks before publication. Live deployment and acceptance evidence are recorded separately.
