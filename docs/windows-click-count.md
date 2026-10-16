# Windows native click counts

Windows coordinate clicks now consume the normalized `clickCount` parameter
(one by default, up to three). Previously the native dispatcher ignored it and
always inserted one down/up pair, even for an explicitly requested double click.
Native requests outside the integer range 1–3 fail before pointer input.

Each pair is inserted together with `SendInput`. Before every pair, the helper
checks the observed HWND/PID, exact foreground and hit-tested pointer target.
If the first click changes the target, no subsequent click is sent there.
No same-process or owner-chain exception authorizes physical input.

The actual `SendInput` return count is retained. After any partial sequence,
the existing `foreground_interrupted_after_partial_hid` contract requires
desktop recovery and forbids replay. An odd event count reports the possibly
held Windows virtual button code (left 1, right 2, middle 4). The helper sends
no blind release to an unverified new target.

Successful dispatch includes the requested click count and inserted event count.
Its business outcome remains `unknown`: it does not prove that an application
selected text or entered header editing mode. That requires a new observation.

The Rust tests cover default/invalid counts, all supported pair counts,
foreground changes between clicks, initial refusal and a partially inserted
pair. Real Windows double-click acceptance against a CI-built isolated helper
is required before release; Linux unit tests alone cannot establish that claim.
