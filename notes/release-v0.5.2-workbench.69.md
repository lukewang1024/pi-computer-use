Windows action preflight protection and request-correlated timeout diagnostics.

## Changes

- Resolve action references using finite provider timeouts reduced to the remaining cooperative lookup budget. Preserve exact RuntimeId or unique AutomationId matching, and restore original timeout settings before returning a target to action dispatch.
- Refuse dispatch after lookup, restoration or elapsed-budget failure. Existing foreground HWND checks and stale-reference refusal remain intact.
- Retain at most 32 sanitized native phase records on transport-unknown errors, with request association, bounded line parsing and stage/elapsed-time fields only. Diagnostic writes cannot panic the helper.
- Cover lookup/restore/deadline failures, chunked and oversized logs, concurrent request isolation, redaction and public no-replay behavior.

## Verification limits

Provider timeouts are cooperative, not a hard process deadline. Enabled/pattern reads, mutation calls and post-action observation can still stall. Diagnostic events never prove input absence or completion and never authorize retry or automatic desktop recovery. Real Word revision-timeout regression remains pending; these changes alone do not establish its root cause or resolution.

Packages must rebuild the Windows x64/ARM64, Linux x64/ARM64 and universal macOS helpers from the exact release source. Existing local macOS signing identity and permission policy remain in effect.
