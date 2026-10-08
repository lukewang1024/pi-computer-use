# pi-computer-use

<p align="center">
  <img src="./assets/logo/logo3.png" width="50%" alt="pi-computer-use">
</p>

`pi-computer-use` lets AI agents use desktop apps on macOS, Windows, and Linux.

The macOS helper requires macOS 14 or newer.

Windows and Linux continuously drain helper diagnostic output so a full stderr pipe cannot block protocol replies. These diagnostics are discarded rather than accumulated in memory or attached to tool results. This does not resolve unrelated native UI provider hangs. Linux also reports lost post-dispatch responses as unknown outcomes, preventing the public executor from replaying input or reusing the old observation. Pre-dispatch cancellation writes no request; terminal native rejections retain their original error codes. Both platforms also handle broken stdin pipes as unknown delivery, retiring the failed helper instead of crashing the host.

An agent can look at an app window, understand the buttons and text inside it, and perform actions like clicking, typing, scrolling, and waiting for something to change. This is useful when the agent needs to work with a normal desktop app instead of an API, a terminal command, or a file.

New to computer use? Start with: [Wait, what exactly is Computer Use?](https://zanechee.dev/what-exactly-is-computer-use/)

## What this package does

This is a Pi extension. After installation, Pi agents get tools for:

- finding open apps and windows
- observing what is visible in a window
- searching the visible interface for text, buttons, and controls
- inspecting parts of the interface in more detail
- clicking, typing, scrolling, and pressing UI controls
- waiting for UI changes

In short: it gives an agent a controlled way to operate desktop software.

## What this package is not

`pi-computer-use` is not a replacement for app APIs or MCP servers. If an app has a reliable direct integration, use that first.

Computer use is most helpful when the only available interface is the app on screen.

## Install

```bash
pi install npm:@injaneity/pi-computer-use
```

Start Pi and follow the platform-specific permission instructions if readiness reports missing access.

On macOS, the helper is installed per user by default. Grant permissions to:

```text
~/Applications/pi-computer-use.app
```

Existing writable system-wide installs remain at `/Applications/pi-computer-use.app`.

Required macOS permissions:

- Accessibility
- Screen Recording, shown as Screen and System Audio Recording on newer macOS versions

Session startup and computer-use tools check these permissions without opening prompts or Settings. If a permission is missing, run `/computer-use permissions` to explicitly request the macOS prompt or open the relevant Settings pane. After changing a toggle, run the command again and choose **Recheck permissions** to restart the helper and check the result.

On Windows, use an interactive desktop session. Windows support uses the platform accessibility APIs and does not use the macOS helper app or TCC permission flow.

Windows window captures verify the same HWND, PID, GUI thread and bounds before
and after GDI capture, then again after encoding and optional UIA extraction.
Moved, resized, minimized or invalidated frames are rejected, as are unavailable
interactive desktops. Bounded capture
retries can refresh geometry but retain the original window owner. Uniform
PrintWindow output still uses the guarded screen-pixel fallback or returns a
capture error; it is not proof that the application itself has a white screen.

On macOS, modal AX dialogs are paired with a visible CG window only when their
geometry matches uniquely in both directions, including floating windows above
the document layer. Missing, moved or ambiguous dialogs stay unpaired. A stored
dialog root is checked against the current AX window and exact CG ID before use;
same-process ownership does not authorize input to another window.

On macOS, exact foreground text temporarily selects an enabled US or ABC keyboard layout when a composing input method is active. The helper restores the prior input source only while it still owns that selection. If the input source changes during typing, remaining text is stopped; already dispatched text must not be replayed. Microsoft Word uses bounded Unicode payloads, with explicit Enter and Tab events for line breaks and tabs. Every physical event still requires the exact foreground window.

On macOS, a click or press on a non-editor control without AXPress uses foreground pointer delivery from its first attempt, including focusable native refs. This fallback requires fresh image grounding while retaining the exact native reference. Semantic AXPress controls and native editor focus keep their existing routes. An unknown result is never replayed automatically.

On Linux, run Pi inside the target user's graphical session with a working AT-SPI2 accessibility bus. AT-SPI semantic operations remain background-first. X11 additionally supports EWMH window metadata/focus, window capture, and policy-gated XTEST physical input; strict headless/background policies never use focus or XTEST. Native Wayland remains semantic-only; diagnostics reads portal capability properties without creating a session, and interactive portal use is disabled. See [Linux support](./docs/linux.md) for the exact capability matrix and portal status.

Use `/computer-use` inside Pi to show the active configuration and where it came from.

## Main tools

- `find_roots`
- `observe_ui`
- `search_ui`
- `expand_ui`
- `inspect_ui`
- `act_ui`
- `read_text`
- `wait_for`

See [docs/usage.md](./docs/usage.md) for the full tool reference.

## Documentation

- [Usage](./docs/usage.md)
- [Architecture](./docs/architecture.md)
- [Configuration](./docs/configuration.md)
- [Development](./docs/development.md)
- [Troubleshooting](./docs/troubleshooting.md)
- [Linux support](./docs/linux.md)
- [Contributing](./CONTRIBUTING.md)

## Development status

The architecture is centered on immutable, state-scoped observations. Desktop surfaces and CDP pages form one multi-root forest; progressive outline queries remain cached, while live work is ordered per physical resource so independent roots can run in parallel. `act_ui` accepts one or more intent steps, preserves focus across dependent input, verifies delivery, recovers safely, stores one complete successor state, and returns a compact diff when identity confidence allows. Older direct tools such as `screenshot`, `click`, `set_text`, and `computer_actions` are no longer part of the public extension surface.

## License

MIT


### macOS OCR failure and pixel evidence

A visual observation can successfully capture a window while Vision text
recognition fails. The macOS helper retains that image and its native
accessibility outline. `details.ocrDiagnostics` reports the bounded error,
`status: failed` and whether recognition completion is confirmed. Failed OCR
never claims text was obtained; use native text evidence when available, or
inspect the actual pixels. Input guards are unchanged. Automatic text search
does not retry OCR in that same failed observation; an explicit new observation
can try again against fresh content. OCR cancellation requested on timeout is
reported as unconfirmed completion rather than successful recognition.

For an isolated managed helper, set an absolute
`PI_COMPUTER_USE_HELPER_SOCKET_PATH` alongside the isolated helper app path.
The SDK launches that exact app with its normal LaunchServices lifecycle.
`PI_CU_SOCKET_PATH` continues to designate an externally owned socket; the SDK
never launches or restarts that external helper. Configuring both socket
variables is rejected before helper operations.

macOS action receipts include `performed.rootDeltaTimings` for root preparation,
the action and its verification, signal polling, post-action AX snapshots and
settling waits. Durations use a monotonic clock. `beforeSnapshotMs` is a subset
of `rootPreparationMs`; do not add both to a total. `afterSnapshotCount` includes
the initial snapshot and any existing bounded catch-up attempts. These timings
exclude earlier request validation, host startup and transport, and do not prove
an action's effect. Input validation, dispatch policy and retry limits are unchanged.


### Navigation performance sampling

`navigate_browser` accepts optional `includePerformance: true`. It collects fixed,
bounded top-frame navigation, paint and buffered observer measurements before the
normal successor snapshot. This avoids a separate `evaluate_browser` call and a
second full accessibility traversal. The default navigation behavior is unchanged;
arbitrary JavaScript evaluation still refreshes the observation and invalidates
old action refs through the existing resource epoch rules.

Successful collection returns `details.performanceSample` and a compact text
summary. Observer entries are capped at64 per type with explicit truncation;
failed observer types are unavailable, not zero-latency evidence. Collection
failure returns bounded `details.performanceError` alongside the successful
navigation's successor state. It never repeats navigation or skips the mandatory
successor snapshot. Failed navigation and snapshot refresh still fail normally.

These are retained top-frame observation-window data, not page health, final
Core Web Vitals or server load capacity. Preserve test conditions and distinguish
positive from zero reported transfer bytes; zero alone does not prove a cache hit.
Use the fresh returned state/refs for subsequent actions, and capture the exact
page separately for visual claims.

### Windows native element reference integrity

A native reference carrying a UIA RuntimeId resolves only to that same live RuntimeId. A reused AutomationId cannot redirect an old reference to a replacement control. When a provider supplies only an AutomationId, resolution requires exactly one live matching element; missing identities and duplicate matches reject the reference. These checks apply to scoped reads and element actions. Exact HWND foreground, desktop, occlusion and unknown-delivery guards remain in force.

This closes an identity fallback gap; it does not establish that every Office UIA provider operation is bounded or that provider-reported action success proves the intended document effect.

Native `observe_ui` reports `targetResolutionMs` before the observation pipeline, `resultBuildMs` for result construction, and `observeRequestMs` spanning target resolution through result construction. The total includes the pipeline and result construction; do not add it to its components. These timings exclude earlier request validation, browser/CDP observations, host startup, transport, and final response serialization. They do not prove action effects or identify the cause of time outside the measured stages.

Browser observations report monotonic wall times in `details.diagnostics.timings`:
CDP discovery, connection, text read, accessibility read, optional image capture,
parallel collection, outline construction, disconnect and the complete snapshot.
Parallel text, accessibility and image phases overlap; do not add them together
or add the snapshot total to its components. An omitted capture has no capture
measurement. A failed accessibility read retains its partial-coverage marker
and measured read duration. Browser result construction separately reports
restore, diff, fold and total times in `browserResultTimings`. These measurements
are retained by `evaluate_browser`, which additionally reports `evaluationMs`
for its requested expression and associated CDP connection, excluding scheduler
admission. Browser `wait_for` reports the final snapshot's diagnostics, not the
total time or all snapshots in its polling loop. These measurements
add no CDP requests or retries and exclude Host startup, transport and final
response serialization. They identify measured stages, not action success or a
general speedup.

Execution summaries report `backgroundFirst` from the first dispatched step. For mixed delivery, inspect each step; a direct foreground action is not reported as background-first. An unknown effect remains unknown and is not automatically replayed.

### Native macOS value confirmation

A native editable control may accept `setText` while leaving its application
model unchanged. If its fresh observed `actions` explicitly include `AXConfirm`,
use a separate `act_ui` action `{"action":"commit","ref":"@eN"}` to commit
that edit. This operation supports only native macOS desktop elements, keeps
the current observation and window binding, and has no pointer or keyboard
fallback. Missing capability, stale references, browser targets, and other
platforms reject the action. A returned confirmation reports `unknown` because
AX success alone does not prove the application saved the value; observe the
result and independently verify saved output. Do not automatically replay it.

### Native macOS invocation

When a fresh native element declares `AXPress`, use `{"action":"invoke","ref":"@eN"}` to invoke that action once. This also supports text controls where ordinary `press` focuses the editor. Invoke keeps the exact observed window and reference, rejects unsupported targets before dispatch, and has no pointer or keyboard fallback. Its result remains `unknown`: inspect fresh state and independently verify the effect before proceeding or repeating an action. Browser targets and other platforms are unsupported.

For native macOS controls declaring `AXPress` or `AXConfirm`, `isEnabled` reports the observed `AXEnabled` value when available. A missing value is unknown. Outline, `search_ui` and `inspect_ui` summaries mark disabled controls; declared actions describe capability and do not guarantee current availability. An observed disabled target rejects before native dispatch, and the helper independently rechecks availability immediately before an explicit native action.

### Finding additional native roots

`find_roots` returns at most 12 roots. When `hasMore` is true, repeat the same
filters with the returned `nextOffset` as `offset` and `rootSetDigest` as
`expectedRootSetDigest`. A changed ranked identity list rejects the page and
requires restarting at offset 0. Each call re-enumerates live
windows, so pages are not a frozen snapshot: verify fresh identities before
actions, and restart at offset 0 when the window set changes. An offset beyond
the current result returns an empty page with `hasMore: false`.

Use `subrole` for an exact platform subrole or Windows window class when many
windows share the same application and title. This filter is case sensitive
and combines with `pid`, `app`, `kind` and text filters before pagination. Root
references and foreground checks retain their existing requirements.
