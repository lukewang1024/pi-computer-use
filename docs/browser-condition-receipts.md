# Compact browser condition receipts

Use `wait_for({stateId, text, role, timeoutMs, includeOutline: false})` when only
the condition result is needed, such as an article heading before fixed metrics.
This opt-in browser mode uses the same scoped AX snapshot condition matcher and
bounded polling as the default. It does not replace AX matching with selectors.

The reply contains found/timedOut, condition fields, nodeCount, baseStateId and a
fresh stateId. It omits outline, rendered outline, changes, diagnostics and images;
it also avoids successor diff/fold work. `search_ui` can query the cached fresh
state. Old element refs remain bound to their original states; observe or search
the fresh state before acting. This mode still collects a full semantic snapshot
for exact matching: it reduces response/result-building cost, not all polling cost.

The default response and native waiting remain unchanged. Native roots reject
false before dispatch. Invalid non-boolean values fail before remote reads.
Timeout remains an explicit false/timedOut result. No input, navigation, screenshot,
retry of failed transport, or application mutation is introduced by this option.
