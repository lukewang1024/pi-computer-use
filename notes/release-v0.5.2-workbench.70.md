Optional pixel-only observation for an exact browser page.

## Changes

- Browser `observe_ui` with `mode=pixels` skips body-text and accessibility-tree collection while returning a fresh original viewport screenshot and state. The structural outline is empty and supplies no semantic action refs. Default visual/fused observations retain their semantics.
- Verify URL and document time origin around capture; unavailable or changed identity fails without another page, desktop fallback or input replay. Preserve viewport dimension checks and exact root/state linkage.
- Expose `semanticCollection=skipped` and timings that include both identity reads and capture. Cover public CDP transport, omitted AX/body reads, old-ref refusal, invalid identity and document drift.

## Verification limits

Local complete plugin and protocol-fixture tests do not establish a real-site performance improvement. Paired managed-browser observations with identical original PNG bytes, stable document identity and independently reviewed images remain required. Tokens and production reliability are not inferred from response byte counts.

This release retains SDK69 native preflight and unknown-input safeguards; no automatic recovery or replay is introduced.
