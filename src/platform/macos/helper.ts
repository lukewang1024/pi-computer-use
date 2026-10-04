import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, realpath } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toBoolean, toFiniteNumber, toOptionalString } from "../coerce.ts";
import type { PlatformDiagnostics } from "../types.ts";
import { resolveMacosHelperAppPath } from "./helper-path.mjs";
import { resolveHelperSocket } from "./helper-socket.mjs";
import { HELPER_PROTOCOL_VERSION, executableSha256, helperIdentityMatches, packagedHelperSha256 } from "./helper-identity.ts";

const COMMAND_TIMEOUT_MS = 15_000;
const HELPER_SETUP_TIMEOUT_MS = 60_000;

export const HELPER_BUNDLE_ID = "com.injaneity.pi-computer-use";
export const HELPER_APP_PATH = resolveMacosHelperAppPath();
export const HELPER_APP_EXECUTABLE_PATH = path.join(HELPER_APP_PATH, "Contents", "MacOS", "bridge");
const DEFAULT_HELPER_SOCKET_PATH = path.join(os.homedir(), "Library", "Caches", "pi-computer-use", "bridge.sock");
const helperSocket = resolveHelperSocket(process.env, DEFAULT_HELPER_SOCKET_PATH);
export const HELPER_SOCKET_PATH = helperSocket.socketPath;
const usingExternalHelperSocket = helperSocket.external;

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SETUP_HELPER_SCRIPT = path.join(PACKAGE_ROOT, "scripts", "setup-helper.mjs");

export class HelperTransportError extends Error {
	readonly code = "helper_transport_unknown";
	readonly outcome = "unknown" as const;
	readonly command: string;
	readonly requestId: string;
	readonly requestWriteAttempted: boolean;
	readonly reason: "timeout" | "aborted" | "socket_error" | "invalid_response";

	constructor(message: string, details: {
		command: string;
		requestId: string;
		requestWriteAttempted: boolean;
		reason: "timeout" | "aborted" | "socket_error" | "invalid_response";
	}) {
		super(message);
		this.name = "HelperTransportError";
		this.command = details.command;
		this.requestId = details.requestId;
		this.requestWriteAttempted = details.requestWriteAttempted;
		this.reason = details.reason;
	}
}

export class HelperCommandError extends Error {
	readonly code?: string;

	constructor(message: string, code?: string, readonly details?: unknown) {
		super(message);
		this.name = "HelperCommandError";
		this.code = code;
	}
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Operation aborted.");
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("Operation aborted."));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	}).finally(() => signal?.throwIfAborted?.());
}

async function isExecutable(filePath: string): Promise<boolean> {
	try {
		await access(filePath, fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}

async function isResolvedHelperExecutable(filePath?: string): Promise<boolean> {
	if (!filePath) return false;
	const [actualPath, expectedPath] = await Promise.all([
		realpath(filePath).catch(() => path.resolve(filePath)),
		realpath(HELPER_APP_EXECUTABLE_PATH).catch(() => path.resolve(HELPER_APP_EXECUTABLE_PATH)),
	]);
	return actualPath === expectedPath;
}

export async function runProcess(
	command: string,
	args: string[],
	timeoutMs: number,
	signal?: AbortSignal,
	env?: NodeJS.ProcessEnv,
): Promise<void> {
	throwIfAborted(signal);

	await new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: ["ignore", "pipe", "pipe"],
			env,
		});

		let stderr = "";
		let stdout = "";

		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			cleanup();
			reject(new Error(`Command timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`));
		}, timeoutMs);

		const onAbort = () => {
			child.kill("SIGTERM");
			cleanup();
			reject(new Error("Operation aborted."));
		};

		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};

		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});

		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});

		child.on("error", (error) => {
			cleanup();
			reject(error);
		});

		child.on("close", (code) => {
			cleanup();
			if (code === 0) {
				resolve();
				return;
			}
			const output = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
			reject(new Error(`Command failed (${code}): ${command} ${args.join(" ")}\n${output}`.trim()));
		});

		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export class MacosHelperClient {
	private daemonAvailable = false;
	private requestSequence = 0;
	private diagnosticsCache?: PlatformDiagnostics;
	private expectedSha256?: Promise<string>;

	private expectedHelperSha256(): Promise<string> {
		return this.expectedSha256 ??= packagedHelperSha256(PACKAGE_ROOT);
	}

	private nextRequestId(): string {
		return `req_${++this.requestSequence}`;
	}

	get diagnostics(): PlatformDiagnostics | undefined {
		return this.diagnosticsCache;
	}

	async ensureInstalled(signal?: AbortSignal): Promise<void> {
		if (usingExternalHelperSocket) return;
		// Existing apps must match this package, not merely share a path/protocol.
		// Upgrades belong to managed deployment, never to an active input session.
		if (await isExecutable(HELPER_APP_EXECUTABLE_PATH)) {
			if (await executableSha256(HELPER_APP_EXECUTABLE_PATH) !== await this.expectedHelperSha256()) {
				throw new Error(`Installed macOS helper build is stale at ${HELPER_APP_PATH}. Run scripts/setup-helper.mjs --runtime from this package at a desktop deployment safe point; physical input was not sent.`);
			}
			return;
		}

		// Re-enter Electron and Bun standalone hosts as their JavaScript runtimes.
		await runProcess(process.execPath, [SETUP_HELPER_SCRIPT, "--runtime"], HELPER_SETUP_TIMEOUT_MS, signal, {
			...process.env,
			ELECTRON_RUN_AS_NODE: "1",
			BUN_BE_BUN: "1",
		});

		if (!(await isExecutable(HELPER_APP_EXECUTABLE_PATH))) {
			throw new Error(`Failed to install pi-computer-use helper app at ${HELPER_APP_PATH}.`);
		}
		if (await executableSha256(HELPER_APP_EXECUTABLE_PATH) !== await this.expectedHelperSha256()) {
			throw new Error(`Installed macOS helper does not match this package at ${HELPER_APP_PATH}; physical input was not sent.`);
		}
	}

	async launchDaemon(signal?: AbortSignal): Promise<void> {
		if (usingExternalHelperSocket) throw new HelperTransportError(`External helper socket is unavailable at ${HELPER_SOCKET_PATH}.`, {
			command: "launch",
			requestId: this.nextRequestId(),
			requestWriteAttempted: false,
			reason: "socket_error",
		});
		await mkdir(path.dirname(HELPER_SOCKET_PATH), { recursive: true });
		// Open the resolved bundle directly so a legacy system-wide copy with the
		// same bundle id cannot win LaunchServices resolution.
		await runProcess("open", ["-n", "-g", HELPER_APP_PATH, "--args", "serve", "--socket", HELPER_SOCKET_PATH], COMMAND_TIMEOUT_MS, signal);
	}

	async daemonCommand<T>(cmd: string, args: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal, requestId?: string): Promise<T> {
		return await new Promise<T>((resolve, reject) => {
			const id = requestId ?? this.nextRequestId();
			const socket = net.createConnection(HELPER_SOCKET_PATH);
			let buffer = "";
			let settled = false;
			let requestWriteAttempted = false;
			let timer: NodeJS.Timeout | undefined;
			const cleanup = () => {
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			};
			const fail = (reason: HelperTransportError["reason"], message: string) => {
				if (settled) return;
				settled = true;
				cleanup();
				socket.destroy();
				reject(new HelperTransportError(
					`${message} (requestId=${id}, outcome=unknown, requestWriteAttempted=${requestWriteAttempted}).`,
					{ command: cmd, requestId: id, requestWriteAttempted, reason },
				));
			};
			const onAbort = () => fail("aborted", `Daemon command '${cmd}' aborted; native completion is unknown.`);
			timer = setTimeout(() => fail("timeout", `Daemon command '${cmd}' timed out after ${timeoutMs}ms; native completion is unknown.`), timeoutMs);
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) onAbort();
			socket.setEncoding("utf8");
			socket.on("connect", () => {
				if (settled) return;
				requestWriteAttempted = true;
				socket.write(`${JSON.stringify({ id, cmd, ...args })}\n`, (error) => {
					if (error) fail("socket_error", `Daemon command '${cmd}' request write failed: ${error.message}; native completion is unknown.`);
				});
			});
			socket.on("data", (chunk) => {
				if (settled) return;
				buffer += chunk;
				const newline = buffer.indexOf("\n");
				if (newline < 0) return;
				try {
					const parsed = JSON.parse(buffer.slice(0, newline));
					if (parsed.id !== id) {
						fail("invalid_response", `Daemon command '${cmd}' returned a mismatched request id; native completion is unknown.`);
						return;
					}
					settled = true;
					cleanup();
					socket.end();
					if (parsed.ok === true) resolve(parsed.result as T);
					else reject(new HelperCommandError(parsed?.error?.message ?? `Daemon command '${cmd}' failed.`, parsed?.error?.code, parsed?.error?.details));
				} catch (error) {
					fail("invalid_response", `Daemon command '${cmd}' returned an invalid response: ${error instanceof Error ? error.message : String(error)}; native completion is unknown.`);
				}
			});
			socket.on("error", (error) => fail("socket_error", `Daemon command '${cmd}' transport failed: ${error.message}; native completion is unknown.`));
			socket.on("close", () => {
				if (!settled) fail("socket_error", `Daemon command '${cmd}' socket closed without a terminal response; native completion is unknown.`);
			});
		});
	}

	async ensureDaemon(signal?: AbortSignal): Promise<boolean> {
		if (this.daemonAvailable) return true;
		try {
			await this.daemonCommand("diagnostics", {}, 1_000, signal);
			this.daemonAvailable = true;
			return true;
		} catch {}
		await this.launchDaemon(signal).catch(() => undefined);
		for (let index = 0; index < 30; index += 1) {
			try {
				await this.daemonCommand("diagnostics", {}, 1_000, signal);
				this.daemonAvailable = true;
				return true;
			} catch {
				await sleep(100, signal);
			}
		}
		return false;
	}

	async command<T>(cmd: string, args: Record<string, unknown> = {}, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<T> {
		const timeoutMs = options?.timeoutMs ?? COMMAND_TIMEOUT_MS;
		let requestId: string | undefined;
		try {
			if (!(await this.ensureDaemon(options?.signal))) {
				requestId = this.nextRequestId();
				throw new HelperTransportError(`pi-computer-use helper app daemon is unavailable at ${HELPER_APP_PATH}; request was not written (requestId=${requestId}, outcome=unknown).`, {
					command: cmd,
					requestId,
					requestWriteAttempted: false,
					reason: options?.signal?.aborted ? "aborted" : "socket_error",
				});
			}
			requestId = this.nextRequestId();
			return await this.daemonCommand<T>(cmd, args, timeoutMs, options?.signal, requestId);
		} catch (error) {
			this.daemonAvailable = false;
			if (!(error instanceof HelperTransportError) && (options?.signal?.aborted || (error instanceof Error && error.message === "Operation aborted."))) {
				requestId ??= this.nextRequestId();
				throw new HelperTransportError(`Daemon command '${cmd}' aborted before a terminal response (requestId=${requestId}, outcome=unknown, requestWriteAttempted=false).`, {
					command: cmd,
					requestId,
					requestWriteAttempted: false,
					reason: "aborted",
				});
			}
			throw error instanceof Error ? error : new Error(String(error));
		}
	}

	async restart(signal?: AbortSignal): Promise<void> {
		if (usingExternalHelperSocket) throw new Error("External macOS helper build mismatch; its owner must restart it. No shutdown or physical input was sent.");
		const identity = await this.diagnosticsCommand(signal);
		if (!(await isResolvedHelperExecutable(identity.executablePath))) {
			throw new Error("macOS helper executable ownership is unverified; refusing to shut down an unrelated daemon.");
		}
		await this.command("shutdown", {}, { signal, timeoutMs: 2_000 }).catch(() => undefined);
		this.daemonAvailable = false;
		await sleep(400, signal);
		if (!(await this.ensureDaemon(signal))) {
			throw new Error(`pi-computer-use helper did not come back after restart. Helper app: ${HELPER_APP_PATH}`);
		}
	}

	async diagnosticsCommand(signal?: AbortSignal): Promise<PlatformDiagnostics> {
		const result = await this.command<any>("diagnostics", {}, { signal });
		const diagnostics = {
			protocolVersion: Math.trunc(toFiniteNumber(result?.protocolVersion, 0)),
			architectureVersion: Math.trunc(toFiniteNumber(result?.architectureVersion, 0)),
			invariants: Array.isArray(result?.invariants) ? result.invariants.filter((value: unknown): value is string => typeof value === "string") : [],
			pid: Math.trunc(toFiniteNumber(result?.pid, 0)),
			parentPid: Math.trunc(toFiniteNumber(result?.parentPid, 0)) || undefined,
			parentAppName: toOptionalString(result?.parentAppName),
			parentBundleId: toOptionalString(result?.parentBundleId),
			parentPath: toOptionalString(result?.parentPath),
			executablePath: toOptionalString(result?.executablePath),
			executableSha256: toOptionalString(result?.executableSha256),
			os: toOptionalString(result?.macOS),
			arch: toOptionalString(result?.arch),
			accessibility: toBoolean(result?.accessibility),
			screenRecording: toBoolean(result?.screenRecording),
			optionalImageFailure: result?.optionalImageFailure === true,
		};
		this.diagnosticsCache = diagnostics;
		return diagnostics;
	}

	async ensureProtocol(signal?: AbortSignal): Promise<PlatformDiagnostics> {
		const expectedSha256 = await this.expectedHelperSha256();
		let diagnostics = await this.diagnosticsCommand(signal);
		const executableMatches = await isResolvedHelperExecutable(diagnostics.executablePath);
		if (helperIdentityMatches(diagnostics.protocolVersion, executableMatches, expectedSha256, diagnostics.executableSha256)) return diagnostics;
		// Never restart a stale executable on disk, nor an externally owned socket.
		if (usingExternalHelperSocket || !executableMatches || await executableSha256(HELPER_APP_EXECUTABLE_PATH) !== expectedSha256) {
			throw new Error(`macOS helper build mismatch: expected ${expectedSha256}, running ${diagnostics.executableSha256 ?? "unknown"}. Repair the installed helper and restart its owner at a desktop safe point; no physical input was sent.`);
		}

		// The helper daemon outlives Pi, so restarting/reloading Pi alone does not
		// replace a stale daemon or one launched from the legacy system location.
		// Stop it through the backwards-compatible command channel and relaunch
		// the exact app bundle that ensureInstalled() resolved.
		await this.restart(signal);
		diagnostics = await this.diagnosticsCommand(signal);
		const relaunchedExecutableMatches = await isResolvedHelperExecutable(diagnostics.executablePath);
		if (!helperIdentityMatches(diagnostics.protocolVersion, relaunchedExecutableMatches, expectedSha256, diagnostics.executableSha256)) {
			this.daemonAvailable = false;
			throw new Error(
				`pi-computer-use helper mismatch after relaunch: expected protocol ${HELPER_PROTOCOL_VERSION}, executable ${HELPER_APP_EXECUTABLE_PATH}, SHA256 ${expectedSha256}; got protocol ${diagnostics.protocolVersion}, executable ${diagnostics.executablePath ?? "unknown"}, SHA256 ${diagnostics.executableSha256 ?? "unknown"}. Reinstall or rebuild the helper app at ${HELPER_APP_PATH}.`,
			);
		}
		return diagnostics;
	}
}

export const macosHelper = new MacosHelperClient();
