# pi-computer-use

<p align="center">
  <img src="./assets/logo/logo3.png" width="50%" alt="pi-computer-use">
</p>

`pi-computer-use` lets AI agents use desktop apps on macOS, Windows, and Linux.

The macOS helper requires macOS 14 or newer.

An agent can look at an app window, understand the buttons and text inside it, and perform actions like clicking, typing, scrolling, and waiting for something to change. This is useful when the agent needs to work with a normal desktop app instead of an API, a terminal command, or a file.

New to computer use? Start with: [Wait, what exactly is Computer Use?](https://zanechee.dev/what-exactly-is-computer-use/)

## What this package does

This is a Pi extension. After installation, Pi agents get tools for:

- finding open apps and windows
- observing what is visible in a window
- searching the visible interface for text, buttons, and controls
- inspecting parts of the interface in more detail
- clicking, typing, scrolling, and pressing UI controls
- waiting for UI changes

In short: it gives an agent a controlled way to operate desktop software.

## What this package is not

`pi-computer-use` is not a replacement for app APIs or MCP servers. If an app has a reliable direct integration, use that first.

Computer use is most helpful when the only available interface is the app on screen.

## Install

```bash
pi install npm:@injaneity/pi-computer-use
```

Start Pi and follow the platform-specific permission instructions if readiness reports missing access.

On macOS, the helper is installed per user by default. Grant permissions to:

```text
~/Applications/pi-computer-use.app
```

Existing writable system-wide installs remain at `/Applications/pi-computer-use.app`.

Required macOS permissions:

- Accessibility
- Screen Recording, shown as Screen and System Audio Recording on newer macOS versions

Session startup and computer-use tools check these permissions without opening prompts or Settings. If a permission is missing, run `/computer-use permissions` to explicitly request the macOS prompt or open the relevant Settings pane. After changing a toggle, run the command again and choose **Recheck permissions** to restart the helper and check the result.

On Windows, use an interactive desktop session. Windows support uses the platform accessibility APIs and does not use the macOS helper app or TCC permission flow.

On macOS, exact foreground text temporarily selects an enabled US or ABC keyboard layout when a composing input method is active. The helper restores the prior input source only while it still owns that selection. If the input source changes during typing, remaining text is stopped; already dispatched text must not be replayed. Microsoft Word uses bounded Unicode payloads, with explicit Enter and Tab events for line breaks and tabs. Every physical event still requires the exact foreground window.

On Linux, run Pi inside the target user's graphical session with a working AT-SPI2 accessibility bus. AT-SPI semantic operations remain background-first. X11 additionally supports EWMH window metadata/focus, window capture, and policy-gated XTEST physical input; strict headless/background policies never use focus or XTEST. Native Wayland remains semantic-only; diagnostics reads portal capability properties without creating a session, and interactive portal use is disabled. See [Linux support](./docs/linux.md) for the exact capability matrix and portal status.

Use `/computer-use` inside Pi to show the active configuration and where it came from.

## Main tools

- `find_roots`
- `observe_ui`
- `search_ui`
- `expand_ui`
- `inspect_ui`
- `act_ui`
- `read_text`
- `wait_for`

See [docs/usage.md](./docs/usage.md) for the full tool reference.

## Documentation

- [Usage](./docs/usage.md)
- [Architecture](./docs/architecture.md)
- [Configuration](./docs/configuration.md)
- [Development](./docs/development.md)
- [Troubleshooting](./docs/troubleshooting.md)
- [Linux support](./docs/linux.md)
- [Contributing](./CONTRIBUTING.md)

## Development status

The architecture is centered on immutable, state-scoped observations. Desktop surfaces and CDP pages form one multi-root forest; progressive outline queries remain cached, while live work is ordered per physical resource so independent roots can run in parallel. `act_ui` accepts one or more intent steps, preserves focus across dependent input, verifies delivery, recovers safely, stores one complete successor state, and returns a compact diff when identity confidence allows. Older direct tools such as `screenshot`, `click`, `set_text`, and `computer_actions` are no longer part of the public extension surface.

## License

MIT


### macOS OCR failure and pixel evidence

A visual observation can successfully capture a window while Vision text
recognition fails. The macOS helper retains that image and its native
accessibility outline. `details.ocrDiagnostics` reports the bounded error,
`status: failed` and whether recognition completion is confirmed. Failed OCR
never claims text was obtained; use native text evidence when available, or
inspect the actual pixels. Input guards are unchanged. Automatic text search
does not retry OCR in that same failed observation; an explicit new observation
can try again against fresh content. OCR cancellation requested on timeout is
reported as unconfirmed completion rather than successful recognition.

For an isolated managed helper, set an absolute
`PI_COMPUTER_USE_HELPER_SOCKET_PATH` alongside the isolated helper app path.
The SDK launches that exact app with its normal LaunchServices lifecycle.
`PI_CU_SOCKET_PATH` continues to designate an externally owned socket; the SDK
never launches or restarts that external helper. Configuring both socket
variables is rejected before helper operations.
