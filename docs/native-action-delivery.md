# Native AXPress delivery

macOS native non-web controls invoke AXPress once. After invocation, an AX
error produces an unknown result with the original status and an explicit
`inputRetryProhibited` receipt. The helper does not refresh and invoke again
or fall back to coordinates. Controls with no AXPress capability may still
use the existing verified pointer path before any native action is attempted.
Menu callbacks continue to require independent effect verification even after
a successful AX status. A successful native status alone is not a Word task
oracle: saved/reopened content and current dialog identity remain separate.

Apple documents that modal processing can outlast the accessibility timeout,
and `kAXErrorCannotComplete` does not necessarily establish action failure:
[AXUIElementPerformAction](https://developer.apple.com/documentation/applicationservices/1462091-axuielementperformaction).
Automatic retries are unsafe for toggles, insertion and submissions when the
first effect is unproven. This change does not solve foreground drift between
keyboard key-down and key-up, permit same-PID physical input, or authorize
replaying unknown actions.

The pure native regression models an action that opens a modal and returns an
AX error, verifying one invocation and the unknown/no-retry receipt. It runs
on macOS CI; non-macOS local runs explicitly skip native execution. Source
wiring checks reject reintroduction of refresh/retry or coordinate fallback
inside the already attempted native press branch. Live Word validation remains
required before adopting a candidate helper.
