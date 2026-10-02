# Nested frame pointer readiness

A nested cross-process frame can expose its new DOM geometry after scrolling
while rendering is still catching up. A valid renderer hit test alone did not
prevent intermittent missed trusted clicks in the managed Mac acceptance fixture.

Before collecting nested pointer geometry, CU now waits for two animation-frame
callbacks in the page and each attached ancestor/leaf renderer. These requests
run concurrently, have a 500 ms renderer deadline and a 1,000 ms command timeout,
and release their timer and animation callbacks. A timeout, exception or missing
acknowledgement rejects the action before mouse input. Existing owner, loader,
viewport, exact hit and geometry checks still run before dispatch. An uncertain
dispatch is never replayed.

In a controlled Mac comparison, 20 newly created nested iframe documents received
20 independent single-click actions. The old implementation missed one action;
the readiness candidate delivered exactly one trusted click in all 20 trials.
Median per-trial elapsed time was 56.42 ms and 73.26 ms respectively, including
the SDK calls and independent event-count observation. These measurements are
fixture evidence, not a production reliability or latency estimate. Separate
33-case registered-SDK browser suites passed on Windows and Mac.

The regression checks in `scripts/check-cdp-ancestor-routes.mjs` cover readiness
failure without input, along with ancestor overlays, navigation, movement and
uncertain dispatch. Desktop acceptance must use an isolated candidate, an owned
browser profile and the managed desktop FIFO. Every trial uses a new iframe;
a missed or uncertain action must not be sent again to the same document.
