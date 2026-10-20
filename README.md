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

Explicit local macOS builds reuse an existing signed helper across SDK-only version changes when its native sources, compiler arguments, toolchain, and installer rules match. Its original signed bundle version and build provenance remain intact. Reuse still checks the resource signature and pinned signing identity; native changes require deployment. This avoids unnecessary recompilation and replacement, but does not grant or restore macOS permissions.

On Windows, use an interactive desktop session. Windows support uses the platform accessibility APIs and does not use the macOS helper app or TCC permission flow.

Windows window captures verify the same HWND, PID, GUI thread and bounds before
and after GDI capture, then again after encoding and optional UIA extraction.
Moved, resized, minimized or invalidated frames are rejected, as are unavailable
interactive desktops. Bounded capture
retries can refresh geometry but retain the original window owner. Uniform
PrintWindow output still uses the guarded screen-pixel fallback or returns a
capture error; it is not proof that the application itself has a white screen.

Windows accessibility extraction reserves up to sixteen slots for late documents,
visible editors, buttons and expandable panes within its existing 200-element budget.
It examines at most 64 omitted candidates for 500ms and continues to report
truncation. This keeps content controls from being displaced by large ribbons;
an incomplete tree still needs scoped inspection before grounding input.

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
- `start_recording`, `recording_status`, `stop_recording` (Windows, macOS, Linux X11)

Continuous recording captures the desktop/screen and cursor at 30 fps by default
while the agent operates UI tools. Install FFmpeg with `libx264` and the platform
capture device (`gdigrab`, `avfoundation`, or `x11grab`), or set
`PI_COMPUTER_USE_FFMPEG` to its executable path. macOS needs Screen Recording
permission; Linux needs an X11 session. See [recording usage](./docs/usage.md#native-screen-recording).

A visible agent cursor is enabled by default on macOS, Windows, Linux X11, and
controlled browser pages. It is an independent, click-through indicator during
computer use, including when no recording is running. `moveMouse` defaults to
virtual animation; use `pointerMode: "physical"` when native hover is needed.
Set `cursor_overlay: false` or `PI_COMPUTER_USE_CURSOR_OVERLAY=0` to hide the
indicator. See [virtual pointer usage](./docs/usage.md#virtual-agent-pointer).

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

`act_ui` accepts optional `outlineView: "folded"` to bound its returned structured UI tree. The complete successor remains available to state-scoped `search_ui` and `expand_ui`; this does not change dispatch, postconditions or stale-reference checks. The default remains the full tree.

`evaluate_browser` also accepts `outlineView: "folded"` and a bounded `outlineQuery`.
Both reuse its original successor snapshot, without evaluating or observing again.
`outlineView` cannot be combined with `includeOutline: false`; a query alone can.
Query receipts report `cachedTreeComplete` and `observedNodeCount` separately from
`exactMatchesComplete`: all exact cached matches may fit while an unobserved tree
frontier still hides additional controls. For scoped uniqueness, require a complete
tree within the caller's node budget and complete exact matches, then inspect each
candidate with `inspect_ui({stateId, ref, includeAncestors: true})`. Check current
state, enabled status and structured ancestor identities; reject truncated ancestor
chains or duplicate scoped targets. Display paths are diagnostic text, not ancestry
proof. Default evaluation still returns the full tree and all stale-state guards apply.

`observe_ui` and `act_ui` also accept an optional `outlineQuery: {text, role, capability}` with at least one nonempty predicate. The response's `queryResult` contains at most 12 ranked matches from the complete saved successor, before folding, with its exact stateId. This cached-only query adds no capture, input or OCR escalation. Check `exactMatchesComplete` and `exactMatchCount === 1` before treating a text query as unique; `exactMatchCount` is null when the exact matches exceed the returned budget. `hasMore` can still be true for lower-ranked matches. Missing query results on terminal failures authorize no input, and all normal stale-reference and foreground guards remain in effect. Pixel-only and metrics-only observations reject this option.

Outline query and `search_ui` matches include `focused` when the native provider reported keyboard focus. `false` means the control was not focused in that snapshot; an omitted field means unknown. A focused window or a single editable match does not establish which editor receives typing, especially in a truncated tree. Windows reads UIA keyboard focus with the retained element's property cache. Focus metadata does not activate, rank, retarget or authorize input; observe and ground the intended editor before acting. A known focus fact becoming unavailable returns a replacement outline view to clear the previous fact.


The architecture is centered on immutable, state-scoped observations. Desktop surfaces and CDP pages form one multi-root forest; progressive outline queries remain cached, while live work is ordered per physical resource so independent roots can run in parallel. `act_ui` accepts one or more intent steps, preserves focus across dependent input, verifies delivery, recovers safely, stores one complete successor state, and returns a compact diff when identity confidence allows. Older direct tools such as `screenshot`, `click`, `set_text`, and `computer_actions` are no longer part of the public extension surface.

## License

MIT

### Managed browser downloads

A trusted integration can provision an existing absolute directory and set
`PI_COMPUTER_USE_DOWNLOAD_ROOT` before launching its SDK host. Each
`launch_browser` creates a private unique subdirectory there and returns its
path as `details.managedDownloadDirectory`. The root's final component must
be a directory rather than a symlink or junction. This setting is machine
configuration, not a tool parameter or filesystem permission grant: the host
must authorize the root through its existing filesystem policy.

The owned browser starts on a blank page. Download configuration must succeed
before navigation to the requested URL; failure closes that browser instead
of falling back to the user's Downloads directory. Without this setting,
standalone browser behavior is unchanged. Downloaded files are retained for
inspection; managed integrations should use their normal guarded filesystem
operations to remove verified artifacts explicitly.

The SDK retains the CDP connection that owns the download override for the
managed browser's lifetime. Unexpected loss of that connection stops the
owned browser and rejects subsequent input; it never reconnects and replays
an action to recover a missing download. Session cleanup closes that owned
connection explicitly.

### Managed browser cleanup

Each launch allocates a fresh temporary browser profile. Replacement and
session shutdown wait up to three seconds for the exact owned child to exit,
then remove that profile. Transient `ENOTEMPTY`/`EBUSY` removal failures
receive at most three further attempts, with the original directory identity checked again before each.
This retries filesystem cleanup only, never input or process termination.
Historical profiles and external browsers are never adopted or swept. Download artifacts in the configured download root remain
available for inspection.
`launch_browser` returns this child's PID and profile path in
`details.managedBrowser` for integrations to verify cleanup independently.
In interactive mode, launch requests `Page.bringToFront` once for that exact
newly owned CDP page before the initial observation. Headless mode skips this
request. `launchTimings.pageActivationMs` measures the request, not a verified
native foreground state or input delivery. Failed activation closes the owned
browser without replay or fallback to another page. Existing native foreground
and stale-reference guards still apply to later physical input.
Interactive Windows launches also disable Chromium's native window-occlusion
backgrounding for this fresh private browser. This keeps a covered page rendering;
it does not prove that its HWND owns the foreground. Headless, macOS and Linux
launches retain their existing rendering policy. No existing browser profile or
system browser setting is changed.

If exit cannot be verified, cleanup reports failure and retains the child,
profile and CDP port. A replacement launch is refused. Later cleanup can
reconcile an observed exit without sending another termination signal; it
does not restart a browser or replay input. Profile identity changes also
prevent deletion, and profile symlinks are not followed to external files.


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

`navigate_browser` accepts optional `outlineView: "folded"` to bound only the
returned outline. Navigation retains its complete successor for cached queries;
omitted descendants are disclosed. This does not add another navigation or
snapshot, change readiness, or authorize old references. The default remains
full. When only a condition receipt is needed after navigation, the existing
browser `wait_for(includeOutline: false)` retains its original predicate and
complete saved state without returning the full tree.

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

For interactive inspection, `observe_ui({root, mode: "semantic", outlineView: "folded"})` returns only the structured nodes present in the rendered outline. It retains the complete observed tree internally, so `search_ui` can locate omitted controls and `expand_ui({stateId, ref, includeSubtree: true})` can disclose their hierarchy without another capture. The returned outline has `view: "folded"`, `returnedNodeCount` and `observedNodeCount`; nodes whose descendants are omitted have `disclosure: {childCount, omittedNodeCount}`. Omitted controls are not absent controls. Native `truncated` flags retain their original meaning, and ordinary stateId, availability, foreground and input guards still apply. Folded responses cannot be restored as complete observations. The default remains `outlineView: "full"` for callers that inspect complete structured trees; this option is unavailable with pixel-only or metrics-only observations.

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

Windows PrintWindow blank detection also checks the OS-reported client rectangle
so non-client borders cannot hide a uniform GPU surface. This extra check requires
a single client color bucket, preserving sparse visible text. The whole-image
97% criterion and
exact foreground/owner/desktop/geometry screen-fallback guards are unchanged.
Invalid or clipped client rectangles never classify a capture.

Windows observations with an image expose `captureDiagnostics`: the actual
`print-window` or `screen-bitblt` method, PrintWindow return value and original
DIB row count, dominant-color and total pixel counts before resizing, original
image dimensions, and any screen-fallback foreground checks. A near-uniform
image is capture evidence; it does not establish that the application rendered
a white screen. These fields do not authorize input or change capture guards.

`search_ui` and `outlineQuery` accept an optional boolean `focused` predicate, combined with text, role and capability. `focused: false` matches only explicitly observed false values; unknown focus matches neither boolean. Focus-only queries are allowed. These queries filter the retained snapshot and do not prove that a truncated tree contains every focused control. Searches with a focus predicate never escalate to OCR, which cannot establish keyboard focus. Normal state freshness and input guards remain required.
