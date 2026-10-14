import { recordingInput } from "./recording-input.ts";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import os from "node:os";
import { createRequire } from "node:module";
import path from "node:path";

export interface StartRecordingParams { fps?: number; maxDurationSeconds?: number }
export interface RecordingParams { recordingId: string }
export interface RecordingReceipt {
	recordingId: string;
	state: "starting" | "recording" | "stopping" | "completed" | "failed";
	path: string;
	fps: number;
	frames: number;
	durationSeconds: number;
	bytes?: number;
	error?: string;
}
interface Recording extends RecordingReceipt {
	child?: ChildProcessWithoutNullStreams;
	ready: Promise<void>;
	resolveReady: () => void;
	rejectReady: (error: Error) => void;
	done: Promise<void>;
	resolveDone: () => void;
	diagnostic: string;
	watchdog?: ReturnType<typeof setTimeout>;
}
interface RecordingHost {
	platform: NodeJS.Platform;
	directory: string;
	ffmpeg: string;
	spawn: typeof spawn;
	startupTimeoutMs: number;
	stopTimeoutMs: number;
	env: NodeJS.ProcessEnv;
	input: typeof recordingInput;
}

function defaultEncoder(): string {
	if (process.env.PI_COMPUTER_USE_FFMPEG) return process.env.PI_COMPUTER_USE_FFMPEG;
	if (process.platform === "win32" && process.arch === "x64") {
		try { return createRequire(import.meta.url).resolve("@ffmpeg-installer/win32-x64/ffmpeg.exe"); }
		catch { /* An externally installed FFmpeg remains supported. */ }
	}
	return "ffmpeg";
}

/** Capture runs independently of UI scheduling so act_ui can operate during recording. */
export class ScreenRecorder {
	private readonly host: RecordingHost;
	private records = new Map<string, Recording>();
	private active?: Recording;
	private closing = false;
	constructor(host: Partial<RecordingHost> = {}) {
		this.host = {
			platform: process.platform,
			directory: process.env.PI_COMPUTER_USE_RECORDING_ROOT || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "pi-computer-use", "recordings"),
			ffmpeg: defaultEncoder(),
			spawn,
			env: { ...process.env },
			input: recordingInput,
			startupTimeoutMs: 15_000,
			stopTimeoutMs: 10_000,
			...host,
		};
	}

	async start(params: StartRecordingParams = {}, signal?: AbortSignal): Promise<RecordingReceipt> {
		if (this.closing || this.active) throw new Error("A recording is already active or the session is shutting down.");
		const fps = params.fps ?? 30;
		const duration = params.maxDurationSeconds ?? 60;
		if (!Number.isInteger(fps) || fps < 1 || fps > 60) throw new Error("fps must be an integer between 1 and 60.");
		if (!Number.isInteger(duration) || duration < 1 || duration > 600) throw new Error("maxDurationSeconds must be an integer between 1 and 600.");
		signal?.throwIfAborted();
		const id = randomUUID();
		let resolveReady!: () => void, rejectReady!: (error: Error) => void, resolveDone!: () => void;
		const r: Recording = {
			recordingId: id, state: "starting", path: path.join(this.host.directory, `${id}.mp4`),
			fps, frames: 0, durationSeconds: 0, diagnostic: "",
			ready: new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; }),
			done: new Promise<void>((resolve) => { resolveDone = resolve; }),
			resolveReady: () => resolveReady(), rejectReady: (error) => rejectReady(error), resolveDone: () => resolveDone(),
		};
		// Claim before the first await: concurrent starts cannot launch two encoders.
		this.active = r;
		this.records.set(id, r);
		void r.ready.catch(() => undefined);
		let startupTimer: ReturnType<typeof setTimeout> | undefined;
		const abort = () => { r.error = "Recording start was cancelled."; r.rejectReady(new Error(r.error)); };
		try {
			await mkdir(this.host.directory, { recursive: true });
			if (this.closing) throw new Error("The CU session is shutting down.");
			signal?.throwIfAborted();
			const input = await this.host.input(this.host.platform, fps, this.host.env, signal);
			if (this.closing) throw new Error("The CU session is shutting down.");
			signal?.throwIfAborted();
			const args = ["-hide_banner", "-loglevel", "error", "-n", "-progress", "pipe:1",
				...input,
				"-t", String(duration), "-an", "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2",
				"-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-pix_fmt", "yuv420p",
				"-movflags", "+faststart", r.path];
			const child = this.host.spawn(this.host.ffmpeg, args, { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...this.host.env } });
			r.child = child as ChildProcessWithoutNullStreams;
			child.stdin!.on("error", () => undefined);
			child.stderr!.on("data", (data: Buffer) => { r.diagnostic = (r.diagnostic + data.toString()).slice(-4096); });
			let pending = "";
			child.stdout!.on("data", (data: Buffer) => {
				pending += data.toString();
				const lines = pending.split("\n");
				pending = lines.pop()!.slice(-4096);
				for (const line of lines) {
					const [key, value] = line.trim().split("=");
					if (key === "frame" && /^\d+$/.test(value ?? "")) r.frames = Number(value);
					if (key === "out_time_us" && /^\d+$/.test(value ?? "")) r.durationSeconds = Number(value) / 1_000_000;
				}
				if (r.frames > 0 && r.state === "starting") { r.state = "recording"; r.resolveReady(); }
			});
			child.once("error", (error) => { r.error = `Unable to run FFmpeg. Install it on PATH or set PI_COMPUTER_USE_FFMPEG: ${error.message}`; });
			child.once("close", (code) => { void this.finish(r, code); });
			startupTimer = setTimeout(() => r.rejectReady(new Error("FFmpeg did not produce a frame before the startup timeout.")), this.host.startupTimeoutMs);
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
			// Wall-clock backstop also handles frozen capture devices or stalled encoders.
			r.watchdog = setTimeout(() => { void this.stop(id); }, duration * 1000 + this.host.startupTimeoutMs);
			r.watchdog.unref();
			await r.ready;
			return this.status(id);
		} catch (error) {
			r.error ??= error instanceof Error ? error.message : String(error);
			if (r.child) await this.stop(id);
			else await this.finish(r, null);
			throw new Error(r.error);
		} finally {
			clearTimeout(startupTimer);
			signal?.removeEventListener("abort", abort);
		}
	}

	status(id: string): RecordingReceipt {
		const r = this.records.get(id);
		if (!r) throw new Error("Unknown recordingId in this session.");
		return { recordingId: r.recordingId, state: r.state, path: r.path, fps: r.fps, frames: r.frames,
			durationSeconds: r.durationSeconds, bytes: r.bytes, error: r.error };
	}

	async stop(id: string): Promise<RecordingReceipt> {
		const r = this.records.get(id);
		if (!r) throw new Error("Unknown recordingId in this session.");
		if (r.child && (r.state === "recording" || r.state === "starting")) {
			r.state = "stopping";
			r.child.stdin.write("q\n");
		}
		if (r.child && r.state === "stopping") {
			const timer = setTimeout(() => {
				r.error ??= "FFmpeg did not finalize the video before the stop timeout.";
				r.child!.kill("SIGKILL");
			}, this.host.stopTimeoutMs);
			try { await r.done; } finally { clearTimeout(timer); }
		}
		return this.status(id);
	}

	private async finish(r: Recording, code: number | null): Promise<void> {
		clearTimeout(r.watchdog);
		try {
			if (r.error || code !== 0 || r.frames === 0) throw new Error(r.error || `FFmpeg exited (${code}) without a complete video: ${r.diagnostic}`);
			r.bytes = (await stat(r.path)).size;
			if (!r.bytes) throw new Error("FFmpeg produced an empty video.");
			r.state = "completed";
		} catch (error) {
			r.state = "failed";
			r.error = error instanceof Error ? error.message : String(error);
		}
		r.rejectReady(new Error(r.error || "Recording ended before it could be started."));
		if (this.active === r) this.active = undefined;
		r.resolveDone();
		// Keep recent receipts bounded; video files remain available for explicit upload.
		while (this.records.size > 16) this.records.delete(this.records.keys().next().value!);
	}

	async shutdown(): Promise<void> {
		this.closing = true;
		try {
			const r = this.active;
			if (r) {
				// A pending mkdir/start also observes cancellation before spawning.
				if (r.child) await this.stop(r.recordingId);
				else { await r.done; }
			}
		} finally { this.closing = false; }
	}
}

export const screenRecorder = new ScreenRecorder();
