# Usage

The normal loop is:

1. Find a desktop or browser root.
2. Observe that root and retain its `stateId`.
3. Search, expand, or inspect that immutable state.
4. Act using the same `stateId` and its `@e` refs.

## Tools

| Tool | Purpose |
| --- | --- |
| `find_roots` | Return a bounded, ranked set of desktop and CDP browser-page roots. |
| `focus_window` | Activate and verify one exact visible root before interaction. Supported on macOS, Windows, and Linux; it sends no pointer or keyboard input. |
| `observe_ui` | Capture the current/frontmost root or one exact `@r` root and return a folded outline plus `stateId`. |
| `search_ui` | Run a bounded, ranked query over the full cached outline. |
| `expand_ui` | Show local outline context for one ref. |
| `inspect_ui` | Show fields, rects, actions, and evidence for one ref. |
| `act_ui` | Perform checked actions and return the resulting saved state, showing its changes or a full view when needed. |
| `read_text` | Read fixed pages from state-owned `@e` text or immutable `@o` output. |
| `wait_for` | Wait for a precise, optionally scoped condition. |
| `launch_browser` | Start a managed CDP browser and return its observed page state. |
| `navigate_browser` | Navigate the browser page owned by a state. |
| `evaluate_browser` | Evaluate JavaScript in the browser page owned by a state. |
| `start_recording` | Start continuous desktop/screen capture on Windows, macOS or Linux X11. |
| `recording_status` | Read recording progress or the finalized receipt by recording ID. |
| `stop_recording` | Stop capture and wait for the MP4 to finalize. |

## Refs and state

`find_roots` returns roots such as `@r1`. Every desktop window, transient surface, and CDP page participates in that same forest. `observe_ui` returns element refs such as `@e12` and a `stateId`.

For a background desktop root, call `focus_window({ root: "@r1" })` and continue only when its result verifies the requested process and exact window as main, focused, and frontmost. On macOS the native helper activates the app, raises the selected Accessibility window, and polls those facts for a bounded interval; a successful AX setter alone is not treated as proof. Platform backends without an exact frontmost window identity fail closed.

Every tool that consumes an `@e` ref also requires its owning `stateId`. A state remains queryable while it is in the bounded store, but a mutation from an old resource epoch is rejected as stale. `act_ui` returns the next usable `stateId`; consume it directly instead of observing again. Observe again only after an uncertain external mutation or state eviction.

Truncated textual output receives an immutable session-local ref such as `@o1`. Continue it with `read_text({ ref: "@o1", offset })`; output refs don't use a UI state id. Tool-provided `@o` offsets are UTF-8 byte offsets, while `@e` text offsets count Unicode characters.

Nodes marked `pictureOnly` have visual evidence but no platform accessibility element. Semantic actions cannot target them. Coordinate actions are available only from a current image-bearing desktop state.

## Progressive disclosure

Use `observe_ui({ root: "@r1" })` for the compact first view. Then query without another capture:

```ts
search_ui({ stateId, text: "Save" })
expand_ui({ stateId, ref: "@e7", depth: 3 })
inspect_ui({ stateId, ref: "@e12" })
```

`semantic` observation is cheapest, `fused` is the default, and `visual` forces visual text evidence. Search requires at least one of `text`, `role`, or `capability`. It ranks exact, prefix, and substring text before conservative fuzzy matches, returns a fixed top set with the total match count, and asks the caller to refine broad queries. Search can escalate OCR once when the original desktop look omitted it; that refresh is checked against the state's resource epoch.

## Acting and batching

The public action shape is always transactional:

```ts
act_ui({ stateId, actions: [{ action: "press", ref: "@e12" }] })
```

When an action has an observable completion signal, attach it to the same
transaction. Pi waits through the platform change-notification path and marks
the execution `didnt` with `postcondition_failed` if the application swallowed
the delivered event:

```js
act_ui({
  stateId,
  actions: [{ action: "press", ref: "@e12" }],
  expect: { text: "Archive completed", until: "present", timeoutMs: 3000 }
})
```

Verification reports `verified`, `preexisting`, or `failed`. A preexisting
condition means the requested end state holds, but is not evidence that the
action caused it. Use `ref` for one exact element or `scopeRef` for a subtree;
role-only conditions must be scoped, and value checks require an exact `ref`.

For CDP browser pages, `press` invokes the element's JavaScript activation.
`click` with an exact reference instead sends browser pointer events, including
right/middle buttons and double/triple clicks. It resolves current layout and
checks that the hit element belongs to the referenced target before dispatch.
A disabled, detached, covered or moving target rejects pointer delivery.
Repeated clicks recheck the target between clicks: a failure can mean the first
click already occurred, so inspect the resulting state and never replay the
whole action automatically. Semantic `press` events are untrusted and do not
provide evidence of a physical interaction or an INP measurement.

Batch steps only when the second step does not need to inspect the result of the first:

```ts
act_ui({
  stateId,
  actions: [
    { action: "setText", ref: "@e18", text: "hello" },
    { action: "press", ref: "@e22" },
  ],
})
```

Steps run sequentially against one resource and retain helper checks. The native helper uses one root baseline and final settle for the transaction, and the bridge returns one final observation. If a transition can change the meaning of later refs or requires a decision, send one action, inspect the returned state, then continue.

`act_ui({ stateId, actions, includeImage: false })` omits only the returned
successor image. The original capture and complete saved state remain available,
including for image-grounded input from the successor. This reduces repeated image
transfer when a workflow obtains separate visual evidence. The default still
returns images; terminal failure evidence and all input guards are unchanged.

Desktop `act_ui` accepts `observationMode: "semantic"` when the next decision
only needs the current UI tree. This skips the post-action screenshot and OCR,
returns fresh semantic refs and a successor state, and keeps the input delivery,
foreground, exact-window and stale-state checks. Image-coordinate actions from that
outline-only successor require a fresh image-bearing observation. The default
`"fused"` behavior still captures pixels. Pixel-only input states cannot request
a semantic successor; observe a semantic or fused state first. This option is
currently desktop-only and is rejected for CDP browser contexts before input.

Windows and macOS native `act_ui` also accept `observationMode: "pixels"`.
The input is grounded in the current state as usual; its successor captures a
fresh screenshot without accessibility-tree extraction or OCR. Old semantic
refs are invalidated. Use it when the next step needs only window keyboard or
image coordinates; observe semantic or fused again before querying controls.
`expect` and `outlineQuery` are incompatible and rejected before input. This is
not `includeImage: false`, which only omits the response image while retaining
the original capture policy. Missing helper confirmation or image after input
returns terminal evidence without an actionable successor and never replays
input. Linux and browser contexts reject this option before dispatch.

On Windows, an image-bearing successor after coordinate `typeText` without a semantic
`expect` also performs a bounded native visual follow-up against the input's
saved look, comparing a band around the input point (native radii 768 × 96
points). Changes elsewhere, including the toolbar, do not trigger it. It samples at most six frames with a 2500 ms soft deadline (an
in-flight capture may finish later). Geometry must match; both samples' visible
synthetic cursor footprints and small changes are excluded. UIA is extracted
once after the final frame when requested. `captureDiagnostics.visualFollowup`
reports `change_observed`, `unchanged_at_limit`, `incomparable`, or `unavailable`.
These are heuristic visual observations, not editor acknowledgements: a caret
or unrelated UI change can still affect pixels, and short edits can remain below
the threshold. Neither text fidelity nor render completion is established, and
the action is never replayed. Use independent text/file checks for correctness.
Native `performed.deltaObservation` separately identifies Windows root/event
checks as `scope: "roots"`, with content and render checks explicitly false.

For browser CDP actions with `expect`, the snapshot that satisfies the condition
is returned as the successor state. It is collected after input within the same
resource write epoch; the bridge does not collect another full accessibility
tree before returning. Actions without `expect` still collect a new successor
snapshot. Previous input states remain stale, and a timed-out postcondition
never causes the action to be replayed.

Clicks at image-grounded points or clicks/presses on editable `@e` refs establish foreground focus for later keyboard steps in the same transaction. A separate `act_ui` call does not inherit tracked focus. Omit `ref` from `typeText` or `keypress` after such a click so input is sent to the editor established by that click:

```ts
act_ui({
  stateId,
  actions: [
    { action: "click", ref: "@e1" },
    { action: "typeText", text: "hello" },
  ],
  expect: { text: "hello" },
})
```

For a screenshot-only editor, click its image-grounded point, then type with an explicit image point in a fresh image-bearing state. On Windows, `typeText` sends to current keyboard focus; it does not focus a child merely because an element or point was supplied. Verify the text is in the intended editor before submitting. Window `@r` refs support `keypress` only. Targetless keyboard actions remain invalid in headless mode and outside a batch that establishes focus.

The runtime prefers background semantics when they are credible, verifies the result, and escalates side-effect-free failed keyboard input to foreground delivery automatically. Ambiguous pointer actions are never replayed blindly.

### Successor views

The initial `observe_ui` response is a full folded view. A normal `act_ui` response saves the complete resulting state but renders only its trustworthy changes:

```text
Successor diff (1 change, S1 → S2):
~ @e9 (@e1 > @e9) value="hello"
Use stateId S2 for subsequent actions and queries.
```

Confidently matched elements retain their model-facing refs across resulting states. New nodes receive new refs and removed nodes are named explicitly. The runtime returns a full folded view instead when the root was replaced, identity confidence is low, or the change budget is too large. `search_ui`, `expand_ui`, and `inspect_ui` always query the complete saved state regardless of how it was rendered.

Coordinate fallback uses image pixels from the observed state:

```ts
act_ui({ stateId, actions: [{ action: "click", x: 420, y: 300 }] })
```

## Bounded output

Every model-visible textual result is limited to 48 KiB or 2,000 lines. Oversized results return a 16 KiB preview, focused-query guidance, and an immutable `@o` continuation. Discovery tools don't page through irrelevant matches: refine `find_roots` and `search_ui` instead. Continuation is intended for concrete long text, evaluation values, and diagnostics.

## Browser use

Browser-specific commands operate only on CDP browser-page states. `launch_browser` chooses the configured browser and debugging port internally and immediately returns an observed state:

Launch diagnostics include `launchTimings` in milliseconds for executable
resolution, port allocation, download-directory preparation, previous owned
browser closure, process creation, CDP readiness, page discovery and initial
observation. `totalMs` covers the launch operation; it excludes prior SDK
readiness checks and Controller/CLI transport. Optional download configuration
and navigation are included in that total but are not separate phases. These
timings identify costs in a successful launch, not native input latency or a
reliability estimate. Failed launches retain their existing shutdown and
unknown-outcome handling and never automatically relaunch.

```ts
const launched = launch_browser({ url: "https://example.com" })
act_ui({ stateId: launched.stateId, actions: [{ action: "press", ref: "@e7" }] })
navigate_browser({ stateId: returnedStateId, url: "https://openai.com" })
evaluate_browser({ stateId: returnedStateId, expression: "document.title" })
```

Browser states use the same outline, action, text, and condition contracts as desktop states. Native browser windows remain ordinary desktop UI; use `observe_ui` and `act_ui` rather than `navigate_browser` or `evaluate_browser` on them.

## Parallel calls

Pi may issue tool calls concurrently. Cached queries can overlap freely. Live work for different desktop processes or CDP pages can overlap; work for the same physical resource is ordered. Do not intentionally race two mutations derived from the same state: one wins and the other receives a stale-state error by design.

### Focus and optional capture

`focus_window({root: "@r1"})` defaults to focus-only. It returns native focus evidence and exact main/focused/frontmost verification, without an image or new `stateId`. Set `capture: true` to request an optional observation. Its `observation.status` is independent of focus: `captured`, `omitted`, or `failed`. Failure does not erase the focus receipt or imply input dispatch uncertainty. A failed verification still forbids input.

Actions require their own valid grounding and the unchanged per-event foreground gate. Obtain a fresh semantic observation for AX actions; only pixel-grounded actions require an image. Ordinary macOS readiness checks Accessibility using passive diagnostics and reports Screen Recording separately. Capture availability is tested when an image is requested, not as a global permission precondition.

Optional capture has a 9-second caller budget (native SCK budget remains 8 seconds). Cancellation requested is not native completion. A late result is discarded before publishing observation state. Native diagnostics expose bounded, metadata-only capture records (request ID, PID/window, shareable/image/fallback timing and completion). At most four unfinished capture tasks are admitted; further captures report busy while input and AX operations retain their own eligibility rules. Unknown input dispatch and uncertain native focus transport remain protected.

### Dispatch receipts and optional observation

`keypress` requires an exact current outline `ref` in the public action schema.
A native terminal reply sets `execution.dispatchCompletion: "returned"`; this does
not prove the requested effect. `effectVerification: "unverified"` with generic
`outcome: "unknown"` can mean no observable delta (for example Save). Explicit
`transport`/`inputDispatch` uncertainty still forbids replay and requires recovery.

Native `observe_ui` obtains real semantic evidence before an optional image. Image
failure returns semantic refs and `observation.status: "semantic_only"`, no image.
`nativeCompletion: "unconfirmed"` is not proof native capture work has stopped;
use native diagnostics for its request/task lifecycle. Pixel actions still require
a valid image, and all input retains its exact target/foreground preconditions.

### Windows pixel-only observation

Use `observe_ui({root: nativeRootRef, mode: "pixels"})` when an exact Windows native window is known and only its pixels are needed. This mode skips UIA and OCR, requires a successful image, and marks the unobserved semantic subtree as truncated and picture-only. It does not return semantic element refs. Unsupported platforms, browser CDP roots, and omitted roots are rejected before capture. Search and semantic postconditions require a new semantic/fused observation.

Coordinate actions remain subject to the existing headless policy, exact HWND foreground checks, captured geometry checks, and stale-reference guards. Their successor capture keeps pixel-only mode; a returned HID dispatch still has an unverified effect and must not be automatically replayed or treated as a verified edit. Inspect the fresh image independently. Native capture failure remains a failure, and older helpers that do not acknowledge skipping UIA cannot establish a pixel-only state. The new path does not make slow semantic provider reads bounded.

### Verified native text selection on macOS

`selectText` selects a unique literal substring in an already focused native
editor. Supply its current `ref`, the complete exact `expectedValue`, and `text`.
`selectionMode` defaults to `range`; `start` and `end` collapse the caret at the
matching substring boundary. Unicode range offsets are computed in the helper.
The operation rejects changed values, ambiguous text (including overlapping
matches), disabled or secure fields, stale references, web areas, and unsupported
selection attributes before setting a range. It does not change focus or fall
back to keyboard or pointer input.

A `worked` result requires the selected range to be read back exactly, unchanged
text, and the same focused editor and observed window. An unverified setter
returns `unknown` and stops remaining actions. Do not replay it. This operation
does not establish batch focus for targetless typing; use an explicit fresh
editor ref, verify the resulting application state, and verify any saved edit
independently. Application support for selection must be tested; API success
alone does not establish that a Microsoft Word note can be edited accurately.

### Browser text event semantics

For browser-backed editable references, `setText` assigns a complete value and
sends synthetic input/change notifications for controlled application fields.
These events have `isTrusted=false`; this is not a keyboard-input acceptance test.
`typeText` with an exact editable reference instead focuses and rechecks that
referenced target, then uses CDP `Input.insertText` in the matching frame session.
It inserts at the editor's current selection/caret, rather than assigning or
appending the value through JavaScript. Verify the actual value and trusted input
receipt in the application before submitting. Remote frame ancestry/document
and focus checks remain mandatory. An unknown dispatch result is not replayed.
Browser insertion does not prove physical keyboard events or IME composition.

Browser text focus is checked within the addressed page/frame, rather than
requiring `document.hasFocus()` to be true in a background browser. For observed
same-process frames, each ancestor iframe must remain connected, own the same
frame ID, and be its parent document's active element. The editable target must
remain connected and active. Remote frame loader/ownership checks are retained.
These checks precede the input command; they are not an atomic guarantee against
arbitrary subsequent application focus changes. Application effect evidence is
still required.

### macOS pixel-only observation

Use `observe_ui({root: exactNativeRoot, mode: "pixels"})` to capture a macOS window without collecting its accessibility tree or running OCR. The helper acknowledges this with `elementCollection: {status: "skipped", reason: "pixel_only_observation"}`. A helper without this acknowledgement cannot establish a pixel-only state. Normal screen capture permissions and exact window identity checks still apply.

The observation contains a nonactionable placeholder and fresh image state. Observe semantic or fused before using element references, querying elements, collecting focus context, or verifying semantic postconditions. Coordinate actions retain the existing foreground, modifier, geometry and stale-state guards; returned dispatch does not verify its effect and must not be replayed. A screenshot alone does not prove successful editing.

Native macOS popup cancellation uses `cancel` with the current exact `AXMenu` root
reference. The menu must declare `AXCancel`; menu items, buttons, picture-only
roots and other platforms are rejected. The helper revalidates the same visible
menu immediately before one AX call, without refinding, raising, Escape, key
releases or retries. Returned API success is dispatch evidence: verify menu
closure from a fresh observation before continuing. This does not cancel an
invisible or unobservable historical menu by PID.

## Virtual agent pointer

The agent pointer is rendered live during computer use; recording is optional.
macOS uses a nonactivating, mouse-transparent desktop window, Windows uses a
layered window that cannot activate, and Linux X11 uses a shaped window with an
empty input region. Browser CDP actions draw the indicator in a closed shadow
root with hit testing and accessibility disabled. These indicators do not move
the operating-system pointer or take keyboard focus.

```ts
act_ui({
  stateId: "S12",
  actions: [{ action: "moveMouse", x: 400, y: 300, durationMs: 600 }],
})
```

All platforms use the same compact 19 × 20 logical-unit northwest arrow, with
a neutral gray fill and a light outline. The chamfered corners soften the small
silhouette. All overlays add a soft neutral radial halo with a 33-unit radius, matching
the Codex cursor treatment. Windows uses a per-pixel alpha layered window; X11
uses an ARGB visual when a compositor is running. X11 sessions without a
compositor retain a shaped arrow, avoiding an opaque halo rectangle.
The hotspot is (2, 1) within the arrow; changing the artwork does not move the action target. Its
orientation does not follow movement. Desktop and browser renderers share the
geometry and palette recorded in `src/agent-cursor-style.json`.

`moveMouse` uses `pointerMode: "virtual"` by default. Its coordinates are grounded
in the current observation, and `path` can supply 2–600 intermediate points.
Duration is bounded to 0–30,000ms. A newer movement replaces the earlier
animation; the pointer hides after inactivity and is cleaned up on session
shutdown. Virtual movement is presentation only: it does not trigger native
hover or establish keyboard focus. Use `pointerMode: "physical"` for an actual
hover operation. Physical native movement retains the existing foreground,
window-ownership, geometry and interruption checks.

Click, press and scroll delivery retains its existing semantics and can also
show the agent indicator. Prefer browser or accessibility actions to keep the
system mouse independent. Native coordinate clicks and drags may still require
the real mouse. `cursor_overlay: false` or
`PI_COMPUTER_USE_CURSOR_OVERLAY=0` hides presentation without changing a virtual
movement into physical input; headless sessions also suppress the indicator.

Rebuild or update native helpers together with the SDK. Older helpers are
rejected before virtual input dispatch instead of silently interpreting the
request as a system-pointer movement. Desktop overlays currently require X11
on Linux; native Wayland overlay rendering is not supported.

## Native screen recording

Recording runs independently of UI actions and continuously encodes H.264 MP4
with the pointer and no audio. Install FFmpeg with `libx264` and the capture device
for your platform, on the host's PATH, or set `PI_COMPUTER_USE_FFMPEG` before starting
the host.

| Platform | Capture | Host setup |
| --- | --- | --- |
| Windows | `gdigrab`, entire desktop | Run on the interactive desktop. |
| macOS | `avfoundation`, selected screen | Grant Screen Recording permission to the recording process/launching application. Screen 0 is selected by name, never camera index 0. Set `PI_COMPUTER_USE_RECORDING_SCREEN` to another screen number if needed. |
| Linux X11 | `x11grab`, entire X screen | Inherit `DISPLAY` and, when needed, `XAUTHORITY`. Install `xdpyinfo` for automatic full-screen dimensions, or set `PI_COMPUTER_USE_RECORDING_SIZE=WIDTHxHEIGHT`. |

macOS and Linux use their native capture inputs, not repeated CU screenshots.
On Linux, native Wayland capture is not supported by the current CU stack:
Wayland sessions are rejected explicitly, including when Xwayland also provides
`DISPLAY`, because that would not record the complete desktop. An absent or
inaccessible desktop, denied macOS permission, or unavailable FFmpeg device
produces an explicit failure instead of a fabricated recording.

No executable
or shell command can be supplied through the model-facing tools. Recordings use
`$XDG_STATE_HOME/pi-computer-use/recordings`, falling back to
`~/.local/state/pi-computer-use/recordings`. Files are retained for explicit transfer
or upload; the tools return local paths, not video bytes or cloud links.

1. Call `start_recording({ fps: 30, maxDurationSeconds: 60 })`. It waits for the
   first encoded frame before returning `recordingId`.
2. Use `find_roots`, `observe_ui`, and `act_ui` normally while recording continues.
3. Call `stop_recording({ recordingId })`. It waits for the encoder to finalize
   the MP4 and returns `state: "completed"`, `path`, `bytes`, `frames`, and
   `durationSeconds`. Only a completed result is ready to upload.

`recording_status({ recordingId })` reports progress and automatic completion.
`fps` accepts integers 1–60; `maxDurationSeconds` accepts integers 1–600 and defaults
to 60. This is a limit starting at encoder startup, not a wait command. For a short
demo, begin recording, perform the operation, then stop it. Capture uses real timing;
it does not retime the video to fit a requested length. Frame rate is a capture
target, and actual throughput depends on the desktop and encoder.

Only one recording runs per CU session. Repeated stops return the same receipt.
Session shutdown stops and finalizes the encoder; startup cancellation, stalled
encoders and failed capture produce explicit errors. Failed files may be incomplete.
Recording does not move the pointer, activate windows, acquire the UI input lock,
or invalidate existing observation refs. A restarted session does not adopt earlier
recording IDs. Recent status receipts are bounded to 16 entries.
