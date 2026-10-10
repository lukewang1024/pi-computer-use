# Native window document evidence

macOS native `observe_ui` results include `windowDocumentEvidence`. This read-only
diagnostic reads `AXDocument` on the exact observed root and, when available,
its direct `AXParent`. It does not guess an owner from the application's main
window, shared PID, window title, position or foreground state.

`status=observed` means the bounded read returned. `documentURL` is present only
for a supported local file URL. `parentDocumentURL` is present only when the
direct AX parent belongs to the same process and represents a window or sheet;
`parentSource=AXParent` identifies that relation. An application parent does not
establish document ownership. Missing URLs remain unavailable evidence.

The observation waits at most 250 ms for this diagnostic. A timed out read is
`unconfirmed`; a still occupied reader is `busy`. The worker remains occupied
until its native read returns, preventing repeated observations from accumulating
background work. No screen capture, native action or input retry is added.

URLs are bounded to 4096 UTF-8 bytes. Non-file URLs, foreign file hosts,
credentials, query strings, fragments, controls and unsupported values are
omitted. This field does not change foreground, stale-reference, disabled-control
or input-dispatch guards. A caller must verify the exact owned fixture and its
independent postconditions before interpreting a dialog as that fixture's result.

Attribute definitions: [AXDocument](https://developer.apple.com/documentation/applicationservices/kaxdocumentattribute) and [AXParent](https://developer.apple.com/documentation/applicationservices/kaxparentattribute).
