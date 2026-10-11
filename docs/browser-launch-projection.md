# Compact browser launch observations

`launch_browser` accepts `outlineView: "folded"` to bound its initial returned structured tree. Omitting the option, or selecting `"full"`, preserves the existing complete response.

Startup retains the complete original observation before projecting its response. The returned state and root, browser/profile ownership, startup timing and failure cleanup are unchanged. Use `search_ui` or `expand_ui` on that state to find omitted targets; refresh observations after subsequent state changes. Folding does not permit old element references, input without grounding, or retrying a launch whose outcome is unknown.

Invalid projection options are rejected before resolving or starting the browser. Projection does not launch again, navigate again, capture another snapshot or send input. A failed original launch retains its original error and verified cleanup receipt; folding only runs after successful startup.

This controls response size, not browser page load cost or field performance. Measure both response bytes and elapsed time on the actual website; bytes are not model token counts or a production reliability estimate.
