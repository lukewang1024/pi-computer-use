# Native searches and pixel capture

`search_ui` queries the saved outline. A matching static label or container is
useful for reading and expanding, even when it cannot invoke an action. Such a
match now stays cached. A role-only miss also stays cached: OCR does not create
the requested native control role. An unmatched text query retains the existing
bounded OCR fallback when the observation allows it.

This avoids an unnecessary screenshot, OCR pass and replacement state after a
successful structural search. It does not turn static nodes into invokable
controls, allow coordinates from an outline-only look, or bypass stale refs.
Use an explicit visual observation when pixels are needed.

In a managed Mac Microsoft Word test, six fused observations were each followed
by the same exact `Document Pane` search. Median query time was 928.37 ms with
the old source and 6.31 ms with the candidate. The old queries replaced the
state during OCR; candidate queries retained their owning state. Both runs
expanded the pane and independently read the expected body text. This measures
that query on one fixture, not total editing time or production latency.

For platform acceptance, prefer an exact process or bundle ID when application
names are localized. Word exposes its page body as an `AXTextArea` on Mac;
do not assume the Windows document-role query applies unchanged. Ground the
current page-content ref and use semantic observation for read-only work.
