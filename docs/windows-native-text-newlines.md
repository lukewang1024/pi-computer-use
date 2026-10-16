# Windows native multiline text

PowerPoint text placeholders ignore CR and LF sent as Unicode keyboard packets.
This can leave a single paragraph even though `typeText` returned after dispatch.
The Windows foreground input path now represents LF, CR, and CRLF as Return key
pairs. CRLF produces one break; repeated breaks retain empty paragraphs. Other
UTF-16 units, including emoji surrogate pairs, remain Unicode packets.

This affects physical `typeText` and the physical `setText` fallback. Existing
exact-window, focused-editor, desktop, policy, and input-lock checks still apply.
It does not change browser insertion or UIA ValuePattern operations. Newlines
have native Return-key semantics; use them only where line breaks are intended.
Dispatch completion still does not prove the text was saved correctly.

Acceptance must save and reopen the document, then inspect native paragraphs in
PowerPoint and Word and cell boundaries in Excel. Include LF, CR, CRLF, blank
paragraphs, and Unicode text. A screenshot that merely shows some inserted text
is insufficient to validate multiline entry.
