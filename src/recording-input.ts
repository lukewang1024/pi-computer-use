import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Host configuration only: no capture device or command is accepted from tool input. */
export async function recordingInput(
	platform: NodeJS.Platform, fps: number, env: NodeJS.ProcessEnv, signal?: AbortSignal,
): Promise<string[]> {
	if (platform === "win32") return ["-f", "gdigrab", "-framerate", String(fps), "-draw_mouse", "1", "-i", "desktop"];
	if (platform === "darwin") {
		const screen = env.PI_COMPUTER_USE_RECORDING_SCREEN ?? "0";
		if (!/^\d{1,3}$/.test(screen)) throw new Error("PI_COMPUTER_USE_RECORDING_SCREEN must be a macOS screen number (default 0).");
		// Device indices include cameras and change as hardware is attached. Select only the exact screen name.
		return ["-f", "avfoundation", "-framerate", String(fps), "-capture_cursor", "1", "-i", `Capture screen ${Number(screen)}:none`];
	}
	if (platform === "linux") {
		if (env.XDG_SESSION_TYPE === "wayland" || env.WAYLAND_DISPLAY) throw new Error("Linux recording requires an X11 session. Xwayland cannot capture the complete Wayland desktop.");
		if (!env.DISPLAY?.trim()) throw new Error("Linux recording requires DISPLAY for the interactive X11 desktop, and its XAUTHORITY when authentication is enabled.");
		let size = env.PI_COMPUTER_USE_RECORDING_SIZE;
		if (!size) {
			try {
				const { stdout } = await run("xdpyinfo", ["-display", env.DISPLAY], { env, signal, timeout: 10_000, maxBuffer: 2 * 1024 * 1024 });
				size = /dimensions:\s+(\d+x\d+)\s+pixels/.exec(stdout)?.[1];
			} catch (error) {
				signal?.throwIfAborted();
				throw new Error(`Cannot query the X11 desktop size. Install xdpyinfo or set PI_COMPUTER_USE_RECORDING_SIZE=WIDTHxHEIGHT: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (!size || !/^[1-9]\d{0,4}x[1-9]\d{0,4}$/.test(size)) throw new Error("PI_COMPUTER_USE_RECORDING_SIZE must be WIDTHxHEIGHT in pixels, or xdpyinfo must return the desktop dimensions.");
		return ["-f", "x11grab", "-framerate", String(fps), "-draw_mouse", "1", "-video_size", size, "-i", env.DISPLAY];
	}
	throw new Error(`Native recording is unsupported on ${platform}.`);
}
