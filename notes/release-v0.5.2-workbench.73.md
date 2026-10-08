# Workbench 0.5.2-workbench.73

Explicit local macOS helper builds now pass runtime freshness only after the
exact source and toolchain fingerprint, sealed app signature, and pinned local
signing identity have been verified. The running helper must still match the
installed executable hash, protocol, and app path. Default prebuilt admission
is unchanged.

The read-only verifier does not build, sign, or update a helper. Missing or
changed inputs reject the session before physical input. Local build hosts must
retain `PI_COMPUTER_USE_LOCAL_BUILD=1` in their desktop runtime environment.

Validation includes fingerprint and signature rejection regressions and the
complete SDK test suite. An owned macOS guest also passed local compilation and
an SDK desktop root query. Full Workbench multi-node matrix acceptance is a
separate release gate.
