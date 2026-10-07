# Cached structural ancestor inspection

`inspect_ui` accepts the optional boolean `includeAncestors`. The default response
is unchanged. With the option enabled, `details.ancestors` contains `rootRef`,
`nodes`, `nodeCount`, `maxNodes` (32) and `truncated`. Each ancestor contains its
original reference, role and title. The array runs from the observed root to the
immediate parent and excludes the inspected target. Inspecting the root returns
an empty complete chain.

The chain is read from the same saved outline and state as the target. It does
not refresh a native window, collect CDP data, focus, or dispatch input. Invalid
options are rejected before cached inspection. A budget overflow, parent cycle
or disconnected parent chain is explicitly incomplete. Clients must reject
incomplete or malformed chains before using them to establish structural scope.

A client can search exact candidates and named scopes in one current state,
require the complete search results, inspect candidate ancestors, and compare
actual ancestor references and labels with the named scopes. This avoids loading
unrelated navigation subtrees merely to prove membership. Display-path text is
not structural evidence. Current enabled/action capability and normal input
state and foreground guards remain required.
