# Windows Bridge

`windows-bridge.exe` is the native helper for the root-forest Windows backend. It is spawned by the TypeScript helper client and speaks stdin/stdout JSON-lines protocol version **4**.

## Backend contract

The TypeScript Windows backend is intentionally stateless. It forwards root-forest seam calls to the Rust helper:

- `listRoots({ pid? })`: cheap HWND metadata only. Roots do not fabricate pairing or sheet counts; HWND/class/style diagnostics live under `metadata` when useful.
- `look`: atomic observe result with `lookId`, outline, window payload (`rootRef`, `kind`, frame, scale), and optional image. Menu/outline-only roots omit `image`; coordinate acts against those roots fail with `coordinate_unavailable_for_root`.
- `act`: forwards the typed `PlatformActRequest` whole. The helper validates `lookId`, resolves refs from helper-owned look state, applies policy, executes, and returns honest outcome/evidence plus `performed.deltaSource` and shallow `rootDelta`.
- `uiaReadText` / `uiaWaitFor`: helper-side live UIA reads/polls. No TypeScript screenshot polling or module-level element state is used.

## Root metadata

Windows roots are top-level HWNDs:

- `#32768` class => `kind: "menu"`
- `#32770` class => `kind: "dialog"`
- owned popups => `kind: "popover"`
- other HWNDs => `kind: "window"`

`metadata.interaction` reports window `enabled`, valid `ownerHwnd`, `ownerEnabled`, and `ownerDisabled` observations. Registered `find_roots` returns these bounded fields as `interaction`, with `disabled` and `owner_disabled` text flags. An enabled owned window can block a disabled document owner. Inspect that exact surface; these fields do not permit redirecting physical input or treating every owned window as modal.

The helper declares per-monitor-v2 DPI awareness at startup and reports `scaleFactor = GetDpiForWindow(hwnd) / 96`.

## Refs, actions, and deltas

RuntimeId arrays returned by UIA are owned by the reader and destroyed when
copying finishes, including bounds/element-read error paths. Returned integer
identities remain opaque copied values. This resource-lifetime repair does not
claim to restore provider-missing identities or change input authorization.

Observed `@e` refs retain RuntimeId from the original live UIA element before property-cache reconstruction, with the cached element as a fallback. If both RuntimeId and AutomationId are unavailable, the outline still exposes readable text and control semantics, but `canPress`, `canSetValue`, `canScroll`, and `canFocus` are false: the reference cannot safely resolve an action target. No name, position, or same-process substitution is permitted.

Ref-targeted actions resolve a live `IUIAutomationElement` first:

- `press`/`click`: `InvokePattern`, then `TogglePattern`, then `SelectionItemPattern`, then `ExpandCollapsePattern`, then LegacyIAccessible default action; successful pattern grounding reports `grounding: "description"`, `delivery: "ax"`. Coordinate fallback is blocked by `ax_only` and preflights occlusion with `ElementFromPoint`.
- `setText`: `ValuePattern.SetValue`, then `CurrentValue` read-back. `evidence.value` is the value actually read.
- `scroll`: `ScrollPattern` where exposed; wheel fallback is raw input and policy-gated.
- `typeText`, `keypress`, `drag`, `moveMouse`, and coordinate targets remain raw input and report `unknown` unless verified.

Action-time reference resolution uses a modern UIA client with finite provider
connection/transaction timeouts (at most 2/3 seconds, reduced to the remaining
8-second cooperative lookup budget). RuntimeId remains authoritative; an
AutomationId-only fallback must still be unique. The original provider timeout
settings are restored before the resolved element can reach an action. Lookup,
restoration, or elapsed-budget failure rejects the action before dispatch.

This is cooperative provider protection, not a hard process deadline: a broken
COM provider can still exceed its requested timeout. Enabled-state and pattern
reads after resolution, actual invocation and post-action observation remain
separate possible stalls. An unknown dispatch result still requires
reconciliation; never retry it as a stale reference. This change alone does not
establish that a particular Word invocation timeout has been fixed.

`readText` resolves the live element and reads TextPattern → ValuePattern → CurrentName. `waitFor` polls the live UIA subtree at about 150ms intervals.

Root deltas are baselined at act time. Bounded WinEvent observations are combined with HWND snapshots (`deltaSource: "win-event+snapshot"`), with snapshot fallback when events are unavailable.

## Truncation ancestry diagnostics

UIA extraction keeps its existing element and ancestry-scan limits. Omitted
nodes sharing a parent chain reuse the already established nearest retained
ancestor within that one extraction. Failed or depth-limited walks are not
cached as complete, and a fresh observation starts with an empty cache.
`uiaDiagnostics.stages` separates subtree enumeration, retained-element metadata
and truncation work. Pattern-availability flags join the retained element
property cache; missing or unreadable cached values fall back to current reads.
This cache is for observation metadata only; action-time element/pattern
resolution and foreground checks remain live.
`uiaDiagnostics.truncationAncestry` reports parent reads, omitted candidates
scanned and cached entries. These counters support live profiling; fewer
synthetic provider calls do not prove an application latency improvement.

## Protocol

Request envelope:

```json
{ "protocolVersion": 4, "id": "req_1", "cmd": "listRoots", "args": {} }
```

Response envelope:

```json
{ "protocolVersion": 4, "id": "req_1", "ok": true, "result": { } }
```

Diagnostics (`cmd: "diagnostics"`) returns the protocol version and helper process metadata. The TypeScript backend rejects a mismatched version with a “Restart Pi …” error.

## Remote acceptance notes

- **Item 5 / menus:** click Notepad's File menu, read `rootDelta`, then observe the `appeared` root's `ref`. Menus are separate roots; observing the original Notepad window will not show the menu contents.
- **Item 7 / occlusion:** record element coordinates from a fresh look, cover the window, then issue a coordinate act (`target: { "x": ..., "y": ... }`, `policy: "default"`). Expect `occluded_target`. Ref-targeted acts may re-resolve and do not exercise this coordinate preflight path.
- **Item 8 / ref re-resolve:** fresh look, capture any element ref, move the window, then act on the same ref with the same `lookId`. RuntimeId/AutomationId re-resolution should succeed with refound semantics, not `stale_ref`.
- **Pressability smoke:** a fresh look at Win11 Notepad must show `canPress: true` on menu bar items and buttons. If not, attach the raw outline dump so the capability matrix can be inspected.

## Local constraints

- Local child process only; no service, socket, or network listener.
- Helper path: `%USERPROFILE%\.pi\agent\helpers\pi-computer-use\windows-bridge.exe`.
- UIAccess/elevated-window limitations are reported as errors; there is no interactive permission grant loop.

## Word workflow observations

On Word 16.0.20430.20092, the caption dialog exposes its editable field as `document/_WwG`, with text-input capability. Its node value can be empty while `read_text` returns the generated caption prefix. Check actual capabilities and current path instead of assuming all text inputs have role `edit`. A semantic `setText` attempt did not change this field; freshly grounded click, End, and suffix typing did. Preserve the generated prefix and its whitespace.

Word's TextPattern omitted a supplementary emoji that was visible in the current caption image and present in saved OOXML as a symbol with a Unicode text fallback. Repeated text polling did not recover it. This is one observed Word configuration, not a general provider guarantee. When necessary, combine exact textual evidence with independently inspected current visual evidence; do not automatically accept a BMP projection as complete Unicode verification. Verify the saved document's full requested text. Caption sequence fields may appear as `fldSimple` instructions or complex `instrText` fields.

The native picture menu and OfficePLUS can both be named 图片. Resolve the current 插图 group path to distinguish the native entry. Use canonical Windows file paths for the file dialog; a mixed-separator test path was rejected as 文件名无效. A delivered insert action followed by an error dialog is not proof of image insertion.


Word's native Accept/Reject split buttons exposed a parent rectangle covering both halves and a default-action child covering the upper half. Parent `press` did not expand the menu. A click in the remaining lower region, computed from freshly inspected rectangles and a current image, opened it. Do not reuse coordinates from a previous observation.

In the tested Word configuration, the menu's `Net UI Tool Window` root had no UIA children although its screenshot showed the menu. The exact menu entries were available under the owning document's UIA tree. After independently confirming the popup's exact owner, one semantic owner-root observation without refocusing found Accept/Reject All Changes. Both saved-document checks passed: acceptance retained the inserted marker; rejection removed it; both removed revision nodes and preserved original contents. These are single-trial observations, not a general provider guarantee.


### Bounded semantic discovery

Windows UIA discovery now runs in a dedicated read-only helper subprocess.
The parent drains its output concurrently (maximum 8 MiB), gives the worker
8.5 seconds including process startup, and terminates and reaps it on expiry.
The existing 8-second cooperative traversal budget and provider transaction
settings remain in place. A stalled `ElementFromHandle`, `FindAll`, or scoped
reference resolution cannot hold this discovery worker indefinitely.

A timed-out full-root extraction returns an incomplete outline with
`uiaDiagnostics.reason = "read_timeout"`, no invented semantic targets, and the
independent window image when capture succeeded. Scoped extraction fails rather
than claiming a successful empty subtree. Worker-local element references are
reassigned in the parent; only JSON and runtime IDs cross the boundary.

The worker mode cannot dispatch actions or activate windows. Input, live action
resolution, exact foreground HWND checks, and stale-reference guards keep their
existing contracts. Pixel-only observations do not start a UIA worker. This does
not bound every other native operation, including root enumeration or live
pattern actions, and does not turn an incomplete outline into semantic success.

The motivating Word traces failed inside `FindAll` after approximately 27–30
seconds before any nodes were visited, despite finite UIA transaction settings.
The worker budget addresses that blocking boundary; cross-platform process tests
cover a hung worker, output larger than pipe capacity, oversized output, and
failed exit. Native Word latency and repeated provider-failure acceptance remain
required before claiming a measured deployed performance improvement.

### Document anchors behind dense sidebars

Truncated extraction reserves slots within the existing 200-node property-cache
limit for up to eight Document controls found just after the initial prefix.
The read-only discovery scans at most 64 tail candidates with a cooperative
500 ms phase budget, inside the existing whole-extraction and subprocess bounds.
Individual provider calls can outlast the cooperative phase budget; the worker
remains the hard containment boundary. This does not promise complete discovery
of arbitrarily large trees or make provider-hidden document text available.

The extraction root remains first. Each selected index is cached at most once;
omitted nodes still participate in bounded ancestry marking. Diagnostic
`documentAnchors` fields report scanned candidates, selected anchors and scan
elapsed time. `rawTruncated` remains true whenever the original tree is incomplete.
The change adds observable semantic refs; it does not loosen live element
identity, exact-window focus, stale-reference or physical-input checks.


Coordinate pointer input now checks `WindowFromPoint` and its exact `GA_ROOT`
after activation and immediately before mouse-button or wheel dispatch. Child
controls belonging to the observed HWND are allowed; a same-process floating
window or an owned popup is still an occluder. Failure reports the target HWND,
PID, point and hit HWND/root/PID without sending button or wheel input. Drag
paths are checked before their first button-down. These checks reduce the
foreground-to-pointer race; they do not make OS input dispatch atomic.

### Timeout phase diagnostics

For native actions, the helper emits at most 32 request-correlated phase events.
The client bounds line buffering, accepts only known stage names and finite
monotonic integer timings, and retains only the current request's last 32 events.
Transport-unknown responses carry this sanitized trail in `execution.transport.stages`.
Records contain stage names and elapsed milliseconds, never action arguments,
window titles or document text. Oversized, malformed and unmatched records are discarded.

This trail can distinguish resolution, enabled/pattern checks, mutation calls
and post-action observation when those stages are received. Missing, late or
last-received stages do not establish whether input occurred or completed.
Unknown delivery still stops subsequent actions and requires reconciliation;
diagnostics never authorize retry or automatic recovery.

During read-only UIA extraction, a cached `IsValuePatternAvailable=false` suppresses an unnecessary live ValuePattern lookup. Missing or unsupported cached metadata preserves the original live lookup. The diagnostic `cachedUnavailableValuePatternSkips` counts actual skipped lookups for retained visible nodes. Values and read-only state for supported patterns still come from the live provider; action resolution and foreground guards are unchanged. This count alone does not establish an end-to-end speed improvement.

## Sparse window captures

A near-uniform `PrintWindow` image triggers the existing guarded screen fallback.
That suspicion threshold does not prove the screen image is blank: a fullscreen
PowerPoint title slide can have more than 97% background pixels and still contain
readable text. After the screen read passes the exact foreground, PID/thread and
geometry checks, a valid OS client rectangle is rejected only when its pixels
occupy one quantized color bucket. Non-client decorations cannot rescue a blank
client. Unavailable client geometry retains the conservative whole-image rule.
This changes capture classification, not window activation or physical-input
permission.

### Explicit observation after a popup obscures its source

An action can open a native popup while capture of its source window fails.
The bridge keeps `post_action_observation_failed`, clears the old state, and
does not replay input or silently make the popup the action successor. When
exact HWND/PID deltas identify one newly appeared, focused same-process window
and a fresh native enumeration confirms that window is visible and focused,
the terminal result includes `nextObservation`: an explicit read-only
`observe_ui` request for its model root ref. This avoids requiring another
`find_roots` just to rediscover the known popup. Uncertain dispatch, unrelated,
replaced, hidden, unfocused, pre-existing, or ambiguous roots receive no hint.
The hint proves neither the action's effect nor popup capture readiness; the
caller must observe it and obtain fresh state before taking another action.

Windows root references use the exact PID/HWND pair consistently across action
deltas, explicit observations and full enumeration. A delta-created popup's
root kind does not create a second identity for the same native window.
Different PIDs or HWNDs remain distinct; this does not change saved-state
validation or authorize input from an earlier observation.
