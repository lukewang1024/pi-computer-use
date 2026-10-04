
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
