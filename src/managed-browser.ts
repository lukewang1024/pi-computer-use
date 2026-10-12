import { spawn, type ChildProcess } from "node:child_process";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ManagedBrowserKind } from "./config.ts";

/** Own one child and one freshly allocated profile; never adopt old profiles. */
export class ManagedBrowser {
	private stopRequested = false;
	private spawnError?: Error;
	private stopError?: Error;
	private closing?: Promise<void>;
	private cleaned = false;
	private constructor(
		readonly child: ChildProcess,
		readonly profileDir: string,
		private readonly identity: { dev: number; ino: number },
	) {
		// Retain asynchronous spawn failures even if startup was canceled first.
		child.once("error", (error) => { this.spawnError = error; });
		child.unref();
	}

	static async launch(executable: string, browser: ManagedBrowserKind, args: string[], signal?: AbortSignal): Promise<ManagedBrowser> {
		signal?.throwIfAborted();
		const profileDir = await mkdtemp(path.join(os.tmpdir(), `pi-${browser}-cdp-`));
		try {
			const identity = await lstat(profileDir);
			signal?.throwIfAborted();
			return new ManagedBrowser(spawn(executable, [...args, `--user-data-dir=${profileDir}`], {
				stdio: "ignore", detached: false,
			}), profileDir, identity);
		} catch (error) {
			await rm(profileDir, { recursive: true });
			throw error;
		}
	}

	/** Revoke this child's operation once; never signal an unrelated PID. */
	requestStop(): void {
		if (this.stopRequested || this.exited()) return;
		this.stopRequested = true;
		try {
			if (!this.child.kill("SIGTERM") && !this.exited()) {
				this.stopError = new Error(`Managed browser stop was not accepted (pid=${this.child.pid ?? "unavailable"}); profile retained.`);
			}
		} catch (error) { this.stopError = error as Error; }
	}

	private exited(): boolean {
		return this.child.exitCode !== null || this.child.signalCode !== null
			|| (this.child.pid === undefined && this.spawnError !== undefined);
	}

	/** A timeout is not exit evidence. Retain ownership and forbid replacement. */
	close(timeoutMs = 3_000): Promise<void> {
		if (this.cleaned) return Promise.resolve();
		if (this.closing) return this.closing;
		this.closing = this.finishClose(timeoutMs).finally(() => { this.closing = undefined; });
		return this.closing;
	}

	private async finishClose(timeoutMs: number): Promise<void> {
		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid browser shutdown deadline.");
		this.requestStop();
		if (this.stopError && !this.exited()) throw this.stopError;
		if (!this.exited()) {
			await new Promise<void>((resolve, reject) => {
				const finish = (error?: Error) => {
					clearTimeout(timer);
					this.child.removeListener("exit", onExit);
					this.child.removeListener("error", onError);
					error ? reject(error) : resolve();
				};
				const onExit = () => finish();
				const onError = (error: Error) => {
					if (this.exited()) finish();
					else finish(new Error("Managed browser shutdown could not be verified; profile retained.", { cause: error }));
				};
				const timer = setTimeout(() => finish(new Error(
					`Managed browser did not exit within ${timeoutMs}ms (pid=${this.child.pid ?? "unavailable"}); profile retained; do not relaunch.`,
				)), timeoutMs);
				this.child.once("exit", onExit);
				this.child.once("error", onError);
				if (this.exited()) finish();
			});
		}
		await this.removeOwnedProfile();
	}

	private async removeOwnedProfile(): Promise<void> {
		for (let attempt = 0; ; attempt++) {
			let current;
			try { current = await lstat(this.profileDir); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") { this.cleaned = true; return; }
				throw error;
			}
			if (!current.isDirectory() || current.isSymbolicLink()
				|| current.dev !== this.identity.dev || current.ino !== this.identity.ino) {
				throw new Error("Managed browser profile identity changed; refusing cleanup.");
			}
			try {
				// rm unlinks symlink entries without following their targets. Chromium
				// can finish profile writes briefly after the owned main-child exit.
				await rm(this.profileDir, { recursive: true });
				this.cleaned = true;
				return;
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (attempt >= 3 || !["ENOTEMPTY", "EBUSY"].includes(code ?? "")) throw error;
				// Retry filesystem cleanup only, never input, child signaling, or launch.
				// Recheck the original inode before every subsequent removal attempt.
				await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
			}
		}
	}
}
