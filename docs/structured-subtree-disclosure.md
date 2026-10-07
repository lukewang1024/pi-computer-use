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
