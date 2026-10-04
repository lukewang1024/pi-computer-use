
## macOS offscreen outline deferral

Native observations retain offscreen containers and their exact refs, but defer
walking their descendants. Deferred containers have `truncated=true`; they are
not empty-subtree claims. `expand_ui` performs an original scoped look from a
fresh root when such a ref is expanded, so descendants remain available on demand.
Visible controls retain the normal breadth-first ordering. Expired traversal
budgets stop additional AX child queries and explicitly mark incomplete nodes.

This targets large native file choosers, where AX can expose hundreds of file
rows that are not displayed. A two-page owned Word Save As discovery on the
preceding SDK21 observed 1,012 nodes, including 233 offscreen containers and
approximately 474 descendants under them; semantic observations took roughly
11–21 seconds. These are baseline observations, not a measured speedup for the
new walker. Native regression fixtures cover visible controls after deferred
rows, explicit expansion, leaves, exhausted budgets and repeated/cyclic identity.
Actual chooser timing and successful PDF export still require candidate acceptance.

## macOS combined visual observation

Helpers advertising `optionalImageFailure` capture pixels and build the native
outline in one look. Capture or JPEG encoding failures can return a fresh semantic
outline with a bounded image error; exact-root, reference and policy failures
still fail the request. The capability flag preserves the semantic-first path
for older helpers. Missing capture lifetime evidence is reported as unconfirmed,
and failed images cannot authorize coordinate grounding in the native look.

Protocol regression tests use the original Mac helper client and backend against
a controlled daemon, asserting one look, no automatic recapture, invalid-ref
preflight rejection, strict errors and legacy compatibility. The shared native
policy tests have also been compiled and run on a managed Mac. These checks do
not establish live chooser latency or PDF export acceptance.
