# macOS text input acceptance

Run this live fixture only through an owned desktop session, using an isolated candidate helper and socket. The test sends physical input to its own window; CI without a graphical session must not claim this test passed.

Compile `native/macos/text_field_input_fixture.swift` with `xcrun swiftc -framework AppKit` into the isolated staging directory. Start it through the managed Executor with a unique title and a private state-file path. Start the candidate helper with `serve --socket <isolated-socket>` and retain the exact managed process IDs for cleanup.

Run `scripts/check-macos-text-input-live.mjs <title> <receipt.json> <state.json>` from the candidate source root with `PI_CU_LIVE=1`, `PI_COMPUTER_USE_HEADLESS=false`, `PI_COMPUTER_USE_HELPER_APP_PATH=<candidate-app>` and `PI_CU_SOCKET_PATH=<isolated-socket>`. Its registered SDK tools verify exact window identity, screenshot availability, Unicode replacement, and disposed-reference refusal.

Before physical typing, the fixture freezes its AX value while the real AppKit field editor continues receiving keyboard events. One `typeText("!")` must insert exactly one marker and produce exactly two key events. A stale AX value must yield `unknown` with `inputPosted=true`, without a foreground retry. An unchanged AX value does not prove that dispatched input had no effect. The independent state-file oracle verifies the actual editor value and event count.

Retain the source/native build hashes, JSON receipt, PNG and managed-process cleanup evidence. Shut down the registered SDK runner, stop only the exact owned fixture/probe/helper processes, and release the desktop session. Do not substitute a mocked backend for this live claim.
