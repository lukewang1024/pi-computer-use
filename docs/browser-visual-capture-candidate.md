# Browser visual observation candidate

Previously, `observe_ui` on an exact CDP root ignored `mode` and returned only
its semantic outline. The candidate captures that exact page viewport for
visual/fused observation; semantic observation, launch, navigation and actions
retain their inexpensive outline-only path.

AX, text and pixels are read through one CDP connection. The screenshot uses
Page.captureScreenshot, includes its real PNG dimensions, and records viewport
CSS dimensions and pixel scale. Browser coordinate input still uses CSS pixels;
prefer grounded refs or explicitly convert screenshot coordinates by pixelScale.
The image is never substituted with a desktop foreground screenshot. Capture
errors remain errors, and image dimensions must match the requested viewport.
Image data is not retained inside the saved reference-state cache.

Browser condition waits now sleep at most the remaining deadline, instead of
adding a full polling interval after the budget is already spent. A CDP command
can still take its own bounded time; the condition budget is not a hard bound on
transport and final snapshot latency.

Run `npm run typecheck`, `npm run test:cdp-viewport`, and
`npm run test:browser-observe`, plus existing schema,
output, lifecycle and resource-concurrency checks. This branch is a candidate:
real Chromium viewport captures, scaling, scrolling, and guard compatibility
must pass through the managed desktop session before publication. An earlier recovered baseline lacked readiness/unknown-delivery scripts; that
historical result did not establish a complete suite pass. The current pixel-only
candidate passes the complete local npm suite, with platform-native skips
reported explicitly; real managed pixel-only acceptance remains pending.

The public executor integration check uses a protocol fixture and stubs only
native readiness/enumeration. It verifies semantic capture avoidance, visual,
fused and default PNG results, successor text state, invalid-image errors,
vanished-target errors, and zero input commands. It is not real application
acceptance.

Managed Windows Chromium module trials cover an ordinary 809x905 viewport and
a scrolled 2385x1800 CSS viewport with emulated DPR=2. The latter exposed an
incorrect division of CDP clip scale by JavaScript devicePixelRatio; correcting
that calculation returned a 1600x1208 original PNG with the scrolled marker.
This is evidence for the tested Chromium/emulation configuration, not all
native display scaling.

Real Windows public executor checks also passed with the candidate source,
the installed pinned SDK dependencies and an isolated copy of the deployed
native helper inside one managed desktop session. Exact-title find_roots,
semantic/visual/fused/default observe_ui, successor read_text and invalid-ref
act_ui rejection were exercised on the owned Chromium tab. The returned PNG
matched the standalone capture bytes. One warm-page sample measured 243ms for
root discovery, 26ms semantic and 46–50ms visual observations; these exclude
Controller transport, session startup and browser launch and are not p95 or
cold-start measurements. The formal extension registry/host package integration
and release regression gate remain pending; this source trial changed no
stable selector or installed package.

## Pixel-only browser candidate

`observe_ui({root: exactBrowserRoot, mode: "pixels"})` captures the exact page
without reading body text or collecting the accessibility tree. It returns a
fresh screenshot state with an empty structural outline and no semantic action
refs. Existing visual/fused observations retain their full semantic behavior.
The current pixel state cannot borrow element refs from an earlier observation;
observe semantic or fused again before using semantic controls.

The SDK reads URL and document time origin before and after capture. Missing
identity or changed URL/time origin fails the observation without falling back
to another page or replaying input. Capture errors and viewport dimension checks
remain intact. `diagnostics.semanticCollection` is `skipped`; `pixelCaptureMs`
includes the two identity reads and screenshot, and `collectionMs` includes the
whole collection phase. No latency, token reduction or real-site improvement is
established by protocol fixtures alone.

New checks cover unchanged screenshot bytes, missing/changed document identity,
zero AX/body requests, exact root/capture/state linkage and refusal of old
element refs with no input dispatch. A paired managed real-browser measurement
with reviewed images is still required.
