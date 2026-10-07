# macOS permission status and direct capture

`checkPermissions` reads Accessibility trust and the Screen Recording preflight
boolean without requesting either grant or enumerating ScreenCaptureKit content.
It returns `captureReadiness: "not-probed"`. A positive preflight is basic permission
status, not proof that the current helper can capture a window or that additional
direct-capture consent is persisted. The UI makes this distinction explicit.

Normal readiness already used cheap helper diagnostics; it continues to do so.
The explicit permission request flow may register Accessibility, request Screen
Recording, and run a live ScreenCaptureKit probe after the user chooses Request.
Those operations may show separate system consent dialogs. An explicit interactive
permission workflow offers the Request choice even when basic grants are already
present; cancelling or checking noninteractively never runs the live probe. Actual screenshot
acceptance still requires a successful capture and independent image inspection.

This removes a known prompt-capable operation from read-only permission status.
It does not establish the cause of any particular two dialogs or guarantee that
macOS will never request direct-capture consent. Formal and candidate helpers
were independently verified to share their bundle identifier, signing certificate,
and designated requirement; changing paths/code hashes alone was not accepted as
a root-cause explanation. Recent logged capture checks belonged to Codex's own
capture service, so they were not attributed to Pi.

Reference: https://github.com/trycua/cua/issues/2296 records the same direct-capture
consent distinction and prompt-capable live capability probes in another driver.

Live repeated-status and capture verification remain required on the target Mac.
Do not clear a quarantined desktop, replay unknown input, or change TCC policy.
