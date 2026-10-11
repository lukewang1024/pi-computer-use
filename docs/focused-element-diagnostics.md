# macOS focused-element diagnostics

Use `observe_ui({root: "@rN", mode: "semantic", focusContext: true})` to diagnose
the application's `AXFocusedUIElement` inside the exact selected native window.
This optional read does not focus anything, capture pixels, invoke actions or
create new element refs. Ordinary observations do not perform the diagnostic.
Browser, Windows and Linux requests reject this option before observation.

`details.focusContext` is separate from each outline node's `focused` attribute.
Providers can report several nodes as focused. A `matched` diagnostic maps only
to a uniquely matching element already in the current outline; its returned
`ref` is that observation's existing model ref. Disabled remains disabled.
The diagnostic is not input authorization, proof of editability or a guarantee
that the application will accept text. Use normal current-state action guards
and independent verification of saved document contents.

An `unobserved` result means exact window ancestry was verified but the element
was absent from the bounded/scoped outline. It has no actionable ref. Ambiguous,
unavailable and budget-exceeded results do not supply one either. Failed or
depth-limited ancestry checks remain unverified; they do not identify another
window as the target. The native diagnostic has a 750 ms elapsed budget checked
between synchronous AX calls, each configured for 50 ms. No new work starts
after the budget expires; the final in-flight call may overrun the elapsed
budget. A rejected timeout configuration prevents that attribute read.

For matched elements, ordinary metadata comes from the current outline. A
nonsecure text input can additionally expose `selectionRange: {location, length}`
from `AXSelectedTextRange`. Both offsets count UTF-16 code units; zero length
denotes a caret. Nonnegative offsets whose sum is at most 100,000 are accepted.
The application must still report the same focused element and exact focused
window after the range read. Missing, malformed, out-of-bounds or changed-focus
results omit the range. Serialization retains it only with a unique existing
ref in the current outline. These extra reads share the same elapsed budget.

The range contains no selected text and does not establish that an intended
selection was made. Verify it against independently observed document contents
and the intended range, and retain normal action guards. In particular, a range
on a disabled element does not make that element eligible for input.

For unobserved descendants, only bounded role, subrole,
labels, enabled state and declared setter capability are read. Missing enabled
state remains unknown. `AXValue` is never read for this diagnostic. Secure or
unknown-security elements omit labels. Metadata and labels are bounded; no
private raw element ref is exposed.

This diagnostic supports investigation of Word editor providers that expose
disabled page-content nodes. It does not fix that compatibility issue or prove
that a differently focused container is an editable document body.
