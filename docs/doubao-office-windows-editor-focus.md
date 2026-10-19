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
