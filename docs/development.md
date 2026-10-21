# Development

## Repository layout

```text
extensions/computer-use.ts       Public Pi tool registration
src/bridge.ts                    TypeScript runtime and tool implementation
src/actions.ts                   Action preparation and result reconciliation
src/runtime.ts                   Immutable state store and resource scheduler
src/state.ts                     Saved UI state ownership and restoration
src/view.ts                      Stable refs and resulting-state change views
src/outline.ts                   Outline parsing, folding, search, and ref mapping
src/note.ts                      Disposable running-note generation
native/macos/bridge.swift        macOS helper for AX, capture, permissions, and input
native/windows/                 Windows backend/helper code when developing on Windows
native/linux/bridge-rs/         Linux AT-SPI2 helper (Rust)
scripts/build-native.mjs         macOS helper build script
scripts/setup-helper.mjs         macOS helper install script
scripts/check-invariants.mjs     Architecture invariant checks
scripts/check-runtime-concurrency.mjs Scheduler/state concurrency checks
scripts/pi-cubench-agent.mjs     Cubench gateway adapter using registered Pi tools
```

The public tool surface lives in `extensions/computer-use.ts`. Keep it small. Internal complexity belongs in `src/bridge.ts`, `src/outline.ts`, `src/note.ts`, and the native helper.

## Checks

Run all static checks:

```bash
npm test
```

This runs TypeScript, tool-schema compatibility checks, architecture invariants, and native helper checks available on the current platform.

On macOS, rebuild the native helper after Swift changes:

```bash
npm run build:native
```

## Architecture rules

The runtime is state-scoped and outline-first:

- `observe_ui` returns a folded UI outline and running note.
- `search_ui`, `expand_ui`, and `inspect_ui` provide progressive disclosure.
- `act_ui` is the only public desktop action entrypoint.
- UI observations are immutable records; request-local hydration replaces global current state.
- Cached queries bypass scheduling; live work is ordered per physical resource.
- Browser pages and desktop surfaces share the `@r` root forest and `@e` outline contract.
- The helper owns grounding, preflight, execution, and verification.
- Removed direct tools such as `screenshot`, `click`, `set_text`, and `computer_actions` should not reappear as public extension tools.

Run invariants after architecture changes:

```bash
npm run test:invariants
```

Set `PI_CU_LIVE=1` only when you want live helper checks in addition to static checks.

## Cubench

`scripts/pi-cubench-agent.mjs` drives a headed Cubench Chromium window through the same registered Pi tools used by the extension. Cubench must launch its web driver headed (the current development tree accepts `CUBENCH_HEADLESS=0`):

```bash
CUBENCH_HEADLESS=0 node ../cubench/bin/cubench.mjs suite run \
  --suite ../cubench/suites/core.json \
  --agent "node --experimental-transform-types $PWD/scripts/pi-cubench-agent.mjs" \
  --driver web \
  --trials 3 \
  --label picu
```

The adapter uses Cubench only for the instruction and final oracle; UI observation and action go through `pi-computer-use`. Gateway action/observation counters therefore do not trigger Cubench interference hooks, so stale/reorder cases need a native-driver integration before their interference timing can be treated as benchmark evidence.

## Native platform helpers

Recording lifecycle and subprocess failures are covered by `npm run test:recording`
using controlled child processes. On an interactive Windows, macOS or Linux X11 host with FFmpeg on
PATH, explicitly run `PI_CU_LIVE=1 npm run test:recording-live` to capture three
seconds and verify automatic MP4 finalization, early stop, session shutdown,
full decoding and encoder exit. This intentionally records the
desktop and retains the resulting file for review. It is excluded from `npm test`.

On macOS, the helper installed for permissions is normally:

```text
~/Applications/pi-computer-use.app
```

Existing writable system-wide installs remain at `/Applications/pi-computer-use.app`. The macOS helper targets macOS 14+ and uses ScreenCaptureKit. Local development can use ad-hoc signing. Release builds must use the release workflow so the helper app is signed with the stable release certificate.

On Windows, development uses the Windows platform backend/helper and the active desktop session rather than the macOS app bundle or TCC permission model.

On Linux, install Rust/Cargo and run `npm run build:linux`, `npm run test:linux`, and `npm run test:linux-scripts`. Live checks must run inside the target user's graphical D-Bus session. The helper installs to `~/.pi/agent/helpers/pi-computer-use/linux-bridge`.

## Release signing

This section applies to macOS releases. macOS TCC keys Accessibility and Screen Recording grants to an app's code-signing identity. Ad-hoc and locally self-signed development builds may require permission review whenever their native code changes. Only Developer ID-signed release bundles should be treated as having a stable update identity.

Before replacing an installed pre-signed helper, `setup-helper` verifies the
candidate and installed bundle signatures and compares their designated
requirements. Updates with a different requirement are refused while keeping
the installed app in place. A stored local signing-identity pin must still be
available; a missing helper with an existing pin also fails closed because its
prior requirement cannot be established. Local pins do not imply that a CI
release uses the same certificate. Any identity migration requires a separate
deliberate procedure; ordinary setup does not perform one.

Release bundles, loose binaries, and locally built binaries all go through the
same per-install lock and staged transaction. Interrupted directory moves are
recovered from a record containing the exact paths, bundle hashes, and
designated requirements. A live lock owner is never taken over only because
its heartbeat is old; stale locks are reclaimed only after the recorded owner
process is dead.

If a published pre-signed app has a different requirement from the installed
helper, setup rejects it and does not silently fall back to a local build. To
select the local identity path explicitly, run
`PI_COMPUTER_USE_LOCAL_BUILD=1 node scripts/setup-helper.mjs`. This bypasses
prebuilt and release candidates, builds the native binary locally, assembles
and signs a temporary app with the available local identity, verifies its
signature and requirement, and submits it through the same locked recovery
transaction. A configured pin must be available, and the resulting requirement
must match the installed app. This path can preserve a locally authorized
identity such as DR root `85ea` without requiring that machine's private key
in CI. If the identity differs, setup still refuses replacement. Same-content
local setup does not re-sign. Ad-hoc changes continue to require the explicit
`PI_COMPUTER_USE_ALLOW_ADHOC_UPDATE=1` development option.

Keep `PI_COMPUTER_USE_LOCAL_BUILD=1` in the desktop host environment when
using this explicit local build mode. Runtime freshness then verifies the exact
source and toolchain fingerprint, the sealed app signature, and the pinned local
signing identity before accepting the installed executable hash. Missing or
changed inputs fail before desktop input; runtime checks never rebuild or sign.
The running helper must still match that executable, protocol, and app path.

Release setup:

1. Run `./scripts/make-signing-cert.sh` once, or use a Developer ID Application certificate.
2. Add repository secrets:
   - `APPLICATION_CERT_BASE64`
   - `CERT_PASSWORD`
   - `SIGN_IDENTITY`
3. For Developer ID notarization, set repository variable `NOTARIZE=true` and add:
   - `TEAM_ID`
   - `APPLE_ID`
   - `APP_SPECIFIC_PASSWORD`
4. Push a `v*` tag or run the `Release` workflow manually.

For macOS, `.github/workflows/publish-npm.yml` builds the universal helper, signs it, optionally notarizes it, stages a draft GitHub Release, injects the same signed helper app into the npm package, publishes npm, and only then publishes the GitHub Release.

For an isolated X11 acceptance run, install Xvfb, xfwm4, the AT-SPI2 runtime,
xfce4-appfinder, and xfce4-terminal, then build and install the helper before
running the explicitly gated live suite:

```bash
npm run build:linux
node scripts/setup-helper.mjs --platform linux
npm run test:linux-live
```

The harness creates its own D-Bus and Xvfb session. It fails rather than
silently passing when the live flag, helper, accessibility bridge, or required
X11 applications are unavailable.

### Virtual pointer appearance

`src/agent-cursor-style.json` records the compact 19 × 20 cursor canvas, (2, 1)
hotspot, fixed northwest geometry, a black fill, and a white outline. Native
macOS, Windows and Linux renderers and the browser SVG keep the same artwork.
Update their surface bounds and hotspot subtraction together when changing size;
never scale the action coordinates or trajectories. `test:agent-cursor` checks
cross-platform geometry and browser canvas dimensions as well as delivery behavior.
The shared specification also records the soft blue radial halo. Its 33-unit radius
extends beyond the arrow canvas; padding keeps it unclipped without moving the
hotspot. Windows and X11 consume the JSON directly through `native/cursor_raster.rs`,
which supersamples the artwork into premultiplied ARGB. Windows uploads it once
with `UpdateLayeredWindow` and `AC_SRC_ALPHA`. X11 selects an alpha-capable Render
visual when the screen has a compositor; without one it uses a shaped arrow.
Both paths retain input transparency. The halo is static and adds no animation
work while idle. Run the Rust `agent_cursor::artwork` unit tests for alpha and
hotspot checks; live X11 acceptance should cover sessions with and without a compositor.

### Virtual pointer verification

Run `npm run test:agent-cursor` for animation, replacement, cleanup, no-input
and three-platform compatibility checks. On macOS compile and run
`native/macos/agent_cursor_tests.swift` with the cursor sources.
The Linux `check_agent_cursor` example is an opt-in live test for a disposable
X server (`PI_CU_CURSOR_TEST=1`). It checks actual composed pixels, animation
positions, both pointer hit-test paths, keyboard focus, real click-through and
idle hiding. Never point that test at a user's desktop: it prepares a test
window and sends one real test click.
Set `PI_CU_CURSOR_EXPECT_ALPHA=1` for a composited session or `0` for the shaped
fallback so a run fails if it exercises the wrong rendering path.

## macOS application-menu refusal diagnostics

A refused application-menu observation retains `stale_ref` and reports the exact guard reason plus the target, foreground, focused-window and ownership PID/window IDs. `unavailable` denotes unreadable metadata. These fields serialize the same observations used by the existing guard; they add no AX reads and contain no window titles, menu labels or document content. The guard runs before and after the menu observation.

Per-application focused-window metadata alone does not establish global foreground ownership. Use the explicit foreground PID/window checks when diagnosing a refusal; do not authorize input from a same-process match or replay a failed action.

## Windows native editor keyboard targeting

For `typeText` addressed to an observed native editor with `canSetValue`, the
helper resolves its live identity in the exact owning HWND, requires an enabled,
focusable, nonsecure Edit/Document control, and checks actual UIA keyboard focus.
If necessary it calls SetFocus once, then requires exact nonempty RuntimeId
equality with GetFocusedElement. Owners, ancestors, descendants, siblings and
same-process windows are not substitutes. Failure sends no physical text and
does not fall back to clicking. Existing focus is retained when it already
matches, preserving the editor selection.

The foreground HWND/PID is verified before focusing and required again before
text delivery. This keyboard path does not use the center-pixel hit test:
an editor's tiny empty-note rectangle can cover a reference glyph instead of
the insertion point. Clicks, pointer operations, web-backed targets and other
coordinate fallback paths retain their existing occlusion checks. A successful
focus check proves targeting only; save and native reopen evidence must still
establish the requested text and document structure.
