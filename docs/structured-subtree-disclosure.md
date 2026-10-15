# Structured local UI disclosure

`expand_ui({stateId, ref, depth: 8, includeSubtree: true})` returns `details.subtree`
with the exact requested node as `root`, its structured children, `nodeCount`,
`maxDepth`, `maxNodes`, and `truncated`. It omits repeated rendered context.
Default calls retain the existing shallow target and rendered outline.

Depth counts edges below the requested root. The default is three; the maximum
is eight. At most 500 nodes are copied. Depth and node frontiers are marked on
both the affected node and the subtree summary. Provider truncation and repeated
node identities also make the summary incomplete. Consumers must reject incomplete
hierarchies when the task requires complete ancestor or uniqueness evidence.

The copied nodes retain original references and capabilities. Serialization does
not mutate cached nodes or grant input authority. Ordinary cached expansion uses
no new CDP observation; the pre-existing scoped refresh for truncated native
observations still applies. Subsequent input must pass the original state and
resource checks. Read-only historical queries and stale input are different:
a reference absent from a queried snapshot fails lookup, while stale input is
rejected before dispatch.

Structured disclosure makes it possible to verify named navigation ancestry
without transferring the unrelated full document or parsing display-path text.
A collapsed descendant is not made actionable by this API; expand its real UI
control through `act_ui`, verify the resulting state, then ground the child in
that successor. No input is automatically retried.


## Explicit native scope refresh

On Windows and macOS, `expand_ui({stateId, ref, refresh: true, depth: 8,
includeSubtree: true})` forces one bounded native scope read using the original
exact-window and element identity. It neither captures a new image nor runs OCR
or sends input. This is useful when an ancestor has a coarse native truncation
marker while the selected child has no local marker. Without `refresh`, existing
cached expansion and automatic frontier reads keep their original behavior.

A successful explicit read returns `details.scopeRefresh` with `requested` and
`performed` true, the model scope ref, and base/current look IDs. This acknowledges
a scope read, not a complete subtree: still require `subtree.truncated === false`
and check the actual scoped controls. The enclosing window may remain incomplete.
Replaced descendants are retired, matching identities retain their refs, and
unrelated controls are preserved. A stale scope, changed exact root, failed native
read or mismatched returned scope/window is an error; it is not permission to
continue with the old partial tree. Browser and Linux roots reject this explicit
option before reading. Original input, foreground and stale-reference guards
remain unchanged.


Mac scoped reads allocate a new native AX wire reference for the same requested
stored element. SDK128 accepts this native renewal only with the same exact
window ID and native window reference, role and identifier. The native helper
still resolves the original requested AX element and checks its descent from the
requested window; there is no title search or same-PID substitution. The public
scope ref stays stable when grafting the fresh subtree. `scopeRefresh.nativeRefRenewed`
records this distinction. Windows continues to require its echoed scope wire ref.
