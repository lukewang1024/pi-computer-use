# CDP keyboard and controlled input candidate

Real TodoMVC testing on the deployed plugin inserted text but did not create
a todo after Enter. A diagnostic keydown listener recorded key="Enter",
code="Enter", keyCode=0 and which=0. Tool dispatch success therefore did not
prove application success.

The candidate supplies standard Windows virtual key codes for named keys,
ASCII letters/digits and function keys, with correct DOM code names. Enter
includes carriage-return text. It leaves native platform key codes unset;
Windows virtual codes are CDP protocol fields, not desktop input. See
[Input.dispatchKeyEvent](https://chromedevtools.github.io/devtools-protocol/tot/Input/#method-dispatchKeyEvent).

Textbox replacement and append use the prototype value setter before emitting
input/change events. This avoids marking an instance-level controlled input
tracker as already updated before the input listener can observe the change.
Contenteditable retains its textContent path. Input remains scoped to the exact
CDP backend node; desktop foreground checks are unaffected.

Behavior checks cover Enter keydown/up, modifier-only fields, Ctrl+A,
replacement/append observed by a controlled-input tracker, and focus setup.
The candidate source loaded by the pinned SDK in a managed Windows session
created exactly one TodoMVC item and cleared its textbox. Original tools
performed selection, setText and keypress; JavaScript only instrumented/read
the result. Broader keyboard layouts and native IME behavior remain unverified.

This source change is not present in the earlier .6 candidate tarball or the
deployed plugin. Rebuild and revalidate the immutable artifact before release.

Browser keypress now requires a live backend node belonging to its observed
state, focuses that exact element, and verifies the document or shadow-root
active element before sending keys. Synthetic root refs without a backend node
cannot stand in for a keyboard target. Runtime.callFunctionOn exceptions are
propagated with bounded diagnostics, so failed focus cannot silently proceed.
A managed Chromium test with two textboxes verified that only the requested
element received Enter after the other textbox was focused, and that a focus
handler stealing focus caused refusal without any further key delivery.


Cross-process iframe references now support guarded pointer activation. The
observed reference binds the outer iframe backend node, child target/frame ID,
parent frame ID and child document loader ID. Before each click, the candidate
checks both child hit ownership and the root compositor's hit on the exact
outer iframe, then checks unchanged geometry and loader identity. Child CSS
coordinates are projected through the observed content quad, including scale
and rotation. A changed document, occlusion or unknown dispatch stops the
remaining action; no automatic replay occurs. Attached sessions and remote
objects are released in finally blocks.

Remote references now expose pointer activation, exact-node text replacement
and append, and document-bound keyboard input. Each key checks child document
identity, outer iframe focus and exact child focus before dispatch through the
child session. Text replacement and append remain semantic input/change
operations; they do not claim trusted typing events. Remote scrolling now uses an exact node as an anchor within the bound child
document. It scrolls the closest ancestor with matching overflow and excess
content on the requested axis, or the child viewport when no such ancestor
exists. Parent-page scrolling is not used. Nested cross-process routing remains
unsupported. A
remote `press` uses the same guarded trusted pointer path; local semantic
`press` retains its JavaScript activation behavior. Read-only remote frames
remain non-actionable when parent ownership cannot be established. These
changes are candidate source and have not been deployed to the stable plugin.


Controlled value replacement and append now search the native value descriptor
through a bounded prototype chain. This preserves framework value tracking for
customized input classes that inherit their native setter rather than declaring
it on the immediate prototype. The instance tracking setter is bypassed when
the inherited prototype descriptor exists. Replacement and append remain
semantic input/change operations; application state is the acceptance oracle.
