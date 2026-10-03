# 0.5.2-workbench.13

Windows UIA observations use the modern automation client with connection and transaction timeouts, a cooperative extraction budget, and explicit incomplete-provider diagnostics. Failed cache updates no longer fan out into unbounded live-property fallback. An incomplete extraction never invents actionable references.

Windows controls with a disabled or unreadable enabled state no longer advertise press, focus, or value-write capabilities. Referenced disabled input is rejected during SDK preflight, including coordinate fallback. Native UIA press checks the current enabled state before dispatch.

Validation includes controlled registered-tool rejection without backend calls, Rust regressions, Windows compilation, and isolated native Word acceptance. Provider calls can still exceed the cooperative budget; scoped extraction and action resolution are not given a hard wall-clock guarantee. These changes do not authorize action replay after an uncertain dispatch.
