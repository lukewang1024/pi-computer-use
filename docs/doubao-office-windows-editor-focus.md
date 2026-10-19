# Doubao Sheet: exact editor keyboard focus

The frozen trial opens an unchanged XLSX, observes the name box at A1,
sets its value to B2 once, then sends Enter to the fresh B2 edit reference.
No pointer rescue is part of this trial.

On the workbench.134 baseline, Enter moved the grid selection to A2 while
the name box had been set to B2. The document hash remained unchanged.
The 81.200098 second original recording has SHA-256
`b98433038cc3b9e855cd3ba088c098885283a0636b50267e4f271514642edc05`.

Candidate d4e85133d984b2adf31cecd105e4351bc05db2a3 was built and
checked by CI run 39274354068, installed through the complete managed
runtime installer, and selected at a desktop maintenance safe point.
Its exact-editor guard refused Enter after UIA SetFocus did not immediately
publish the requested focused RuntimeId. No physical Enter was sent;
the grid remained at A1. This candidate did **not** fix the trial.
The 109.400098 second original recording has SHA-256
`d0540c31ead32ee2b8ff74e743b9458dd409d5b4170155cf685833a82e22e148`.
The original 20 window identities and fixture bytes were preserved, the
CU session was closed, and the stable runtime was restored.

The follow-up observes UIA focus for a cooperative 500 ms after one
SetFocus request. It never repeats SetFocus, clicks a fallback point,
or sends keys before the exact nonempty RuntimeId matches. Wrong,
ancestor, descendant, missing, late, and failed focus observations remain
failures. A provider call itself can exceed the cooperative budget; a
late successful response is rejected. Timeout diagnostics report the
requested and observed RuntimeIds without editor text.

Unit coverage exercises delayed exact focus, sibling/ancestor/descendant
and empty identities, late arrival, and provider failure. Windows native
compilation and the identical recorded live trial are still required.
No success-rate or latency improvement is claimed from unit tests.


## Physical-key scan metadata candidate (2026-10-20)

A separate recorded native Edit probe received Home/Shift/Right with correct
virtual keys and modifiers but scan code zero (system mappings 71/42/77).
A recorded isolated Edge textarea then received six trusted native events with
correct `key` values and empty `KeyboardEvent.code` for both down and up.
Native Home then Shift+Right still selected exactly the first ASCII character
in both controls. Thus empty `code` is established; its role in Doubao canvas
selection failures remains unproven.

The candidate fills `KEYBDINPUT.wScan` from `MapVirtualKeyExW` using the
foreground thread's input layout, preserving virtual-key delivery and existing
extended/key-up flags. Unicode text retains its separate Unicode packet path;
no input-layout switch or input replay is introduced. A Windows-only encoding
test checks nonzero/equal down/up scan metadata, unchanged virtual keys and
flags, and untouched Unicode encoding. Linux tests do not run that test.

Require checked exact-source Windows CI artifacts followed by recorded native
and Chromium probes (expected nonempty Home/ShiftLeft/ArrowRight codes), common
shortcut controls, and saved Doubao selection/formatting oracles before claiming
this fixes the application. Previous W03 failures are retained.

References: [KEYBDINPUT](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-keybdinput)
and [MapVirtualKeyExW](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-mapvirtualkeyexw).


## Recorded scan candidate outcomes (2026-10-20)

Exact-source candidate 77093313 passed its Windows CI and isolated native/Edge
probes: six down/up events carry the expected scan metadata; Edge reports trusted
Home/ShiftLeft/ArrowRight codes. Scoped Sheet Enter/save/undo/redo and PPT
notes/save/slideshow Left/Right/Esc regressions passed with independent persisted
content checks and original recordings. These results do not establish overall
Office acceptance or a performance improvement.

Doubao Word Home/Shift+Right still selected the wrong range in independent plain
and image fixtures. Separate Ctrl+Home controls also failed to establish the
expected first-character range. Formatting was withheld on wrong/uncertain
selections, and the saved control files remained byte-identical to their sources.
The plain and image Ctrl+Home recordings are 246.5 and 53.6 seconds; both fully
decoded. Native window cleanup and session completion were checked.

Grounding must be read from the input state, not the pixel-only successor. The
image control's original pre-keypress fused roots both had public @e1,
wireRef=@w21 and pictureOnly=false. actions.ts therefore maps these keypresses to
the synthetic native window reference, and main.rs uses its direct window branch.
The later pictureOnly successor does not imply a coordinate fallback for the
preceding keypress. A separate @w-vs-@e trial would not isolate that proposed
variable in these records.

A subsequent prospective click/Ctrl+Home/Shift+Right batch stopped after its
unverified click (actionCount=1, stoppedAt=0). Neither keypress was dispatched.
bridge.ts dispatchUiTransaction stops whenever step.outcome is not worked.
This trial establishes a batch limitation, not a Word keyboard failure or a
safe reason to weaken stop rules. Preserve unknown outcomes and avoid replay.

Further diagnosis should establish actual editor focus and event handling before
changing delivery or claiming W03 fixed. Scan metadata repair alone is insufficient.


## Direct foreground keypress routing candidate (2026-10-20)

Seven recorded window-ref keypresses in the visible-range control each show a
background foreground_required refusal before foreground delivery. Windows input.rs
rejects raw keypress for every non-foreground policy, including semantic editor and
synthetic window refs. The action planner now requests foreground directly for
non-headless Windows keypress, as it already does for macOS keypress. Linux and
strict headless retain their existing policy; native exact-window/editor focus,
key encoding, outcome verification and unknown-no-replay rules are unchanged.

Preflight coverage preserves exact window/editor target refs, key preparation,
strict-headless policy and unknown-result no-retry behavior. Native input is not
sent by these tests. Recorded three-app regression and balanced workflow cost
comparison remain required before a live improvement claim. This routing change
does not repair Word Home selection or PPT U+0020/U+00A0 fidelity.
