# Doubao Office native macOS editing

The controlled Word case exposed two native helper gaps. Its canvas appeared
24 nodes below the observed window in the accessibility outline. The old
20-node parent search rejected a hit from the same process before sending
pointer input. The candidate searches at most 64 nodes, stops on cycles or
after its 500 ms budget, and still requires the exact observed ancestor.
Process, window, foreground and hit-test checks remain in force.

A `typeText` request beginning with LF appended its text to the existing
paragraph instead of creating a paragraph. Explicit Enter did create a real
DOCX paragraph. The candidate uses the same CR/LF/CRLF and Tab event plan for
all native apps that Microsoft Word already used. Ordinary non-Word text
retains its existing per-scalar physical-key/Unicode delivery, input-source
lease and foreground checks. It does not replay input after an uncertain
result.

These are source changes. Native unit regressions and helper compilation do
not establish that an installed Doubao session has been fixed. A full managed
runtime installation and recorded same-condition comparison are still needed.

For observation, discover popup roots across applications after an action.
The controlled More popup belonged to a separate Doubao browser process, so
filtering only the main app missed it. Closing the document did not remove
that popup. Raising the original main window dismissed it. The original
document window closed through its exact native AXCloseButton; Cmd-W did not
establish closure in that case.
