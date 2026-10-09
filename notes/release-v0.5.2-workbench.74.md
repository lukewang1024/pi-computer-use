# v0.5.2-workbench.74

Linux native window discovery now obtains application process IDs from D-Bus
connection credentials (`GetConnectionUnixProcessID`). AT-SPI `Application.Id`
is a registry identifier and must not be used as an operating-system PID.
An unavailable connection remains PID 0; no registry-ID fallback is used.

A private-session D-Bus integration test exports an application with registry
ID 42 and verifies the actual process ID, plus an unknown-connection result.
Linux x64 CI explicitly runs this test. The same regression fails with the
previous implementation.

This corrects process identity. It does not establish that an accessibility
bus belongs to the configured display, add a native Linux file-picker workflow,
or prove cross-platform desktop acceptance. Those require separate checks.
