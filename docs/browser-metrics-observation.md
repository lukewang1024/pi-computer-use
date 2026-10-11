# Read-only browser metrics observation

Use `observe_ui({root: "@rN", mode: "metrics"})` with an exact `browser_page`
root from `find_roots`. It runs the SDK's fixed top-frame performance collector
through the original CDP transport. It does not accept JavaScript, navigate,
send input, capture pixels or reconstruct an accessibility tree. It returns
`kind: "browser_metrics"`, `readOnly: true`, bounded performance data and
`observationTimings.metricsReadMs`. Ordinary browser observations are unchanged.
Metrics observations do not return a new actionable state, UI outline or
element refs. Continue to use semantic observations for input grounding.

The collector checks URL and performance time origin across collection. A
document change, missing target, malformed result or read failure returns an
unavailable diagnostic and no performance sample; it never repeats navigation
or input. URL output excludes the query and fragment and is limited to 2048
characters; title and first heading are limited to 512. The identity binds
this read to its document, not to any previous UI state.

The in-page load wait is bounded to 3 seconds, followed by a 100 ms observer
flush. This leaves room inside the existing 5-second CDP command timeout.
Slow loading remains explicitly incomplete. Callers may take another bounded
read of the same exact root to observe later loading, without replaying the
functional interaction. A collection error leaves native completion unconfirmed;
read-only is not a cancellation-completion claim.

Paint, LCP, layout shifts, event timing and long-task buffers have 64-entry caps.
These are retained top-frame observation buffers, not page lifetime, field Core
Web Vitals or a page-health verdict. Provisional or unavailable metrics must not
be relabeled as final values. Functional correctness and metrics availability
remain separate acceptance criteria.

This path avoids the full accessibility successor snapshot required by the
general `evaluate_browser` tool. That general tool still accepts arbitrary
JavaScript and keeps its existing mutation classification and uncertainty
guards. Metrics-only observation is a fixed read, not a way to grant arbitrary
evaluation read-only authority.

## Measurement conditions

SDK98 includes `measurementConditions` in the same fixed collector and compact
summary. It records bounded browser-reported user agent (512 characters), language
(64), layout viewport width/height in CSS pixels, device pixel ratio, visual
viewport width/height/scale, and document visibility. Missing or invalid values are
explicitly null. It requires no additional CDP command, screenshot, navigation or
input. These values do not establish hardware, OS, network, cache or proxy state.

The collector compares conditions before and after its existing asynchronous
wait. `stableDuringCollection=false` and `changedFields` identify observed drift;
the existing navigation result remains available and is never replayed. Stable
conditions do not prove complete metadata or continuous stability between reads.
Performance comparisons must additionally require complete visible-page conditions,
matching environments, comparable transfer groups and caller-declared experimental
controls. Reported zero transfer bytes alone do not prove a cache hit. Unknown
conditions from older SDKs remain unavailable, never an invented matching group.

Viewport units and pixel-ratio semantics follow [Window.innerWidth](https://developer.mozilla.org/en-US/docs/Web/API/Window/innerWidth)
and [Window.devicePixelRatio](https://developer.mozilla.org/en-US/docs/Web/API/Window/devicePixelRatio).
