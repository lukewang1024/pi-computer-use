import type { HelperActResult, PlatformRoot } from "./platform/types.ts";

interface PendingEntry {
	pid: number;
	parentWindowId: number;
	modalWindowId: number;
	modalTitle: string;
	modalClass: string;
	requestId: string;
	state: "pending" | "returned" | "uncertain";
	settled: Promise<void>;
}

export interface PriorModalAction {
	requestId: string;
	completion: "pending" | "returned" | "unknown";
	modalOpen: boolean;
}

function interaction(root: PlatformRoot | undefined): Record<string, unknown> | undefined {
	const value = root?.metadata?.interaction;
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * A completed tool response is not the completion of its detached UIA call.
 * Keep a desktop-wide input fence until that call returns and its modal closes.
 */
export class ModalContinuation {
	private entry?: PendingEntry;
	private activeWrites = 0;
	private monitoring = false;

	/** Prevent concurrent tool writes from being mistaken for the observed click. */
	enterWrite(): () => void {
		if (this.monitoring) throw new Error("A Windows action is being checked for a newly opened modal; no input was sent.");
		if (this.entry && this.activeWrites > 0) throw new Error("Another modal continuation is in progress; no input was sent.");
		this.activeWrites += 1;
		let exited = false;
		return () => { if (!exited) { exited = true; this.activeWrites -= 1; } };
	}

	beginMonitoring(): (() => void) | undefined {
		if (this.entry || this.monitoring || this.activeWrites !== 1) return undefined;
		this.monitoring = true;
		return () => { this.monitoring = false; };
	}

	register(pid: number, parentWindowId: number, modal: PlatformRoot, requestId: string, completion: Promise<HelperActResult>): void {
		if (this.entry) throw new Error("A modal action is already pending; no additional input was dispatched.");
		if (!modal.windowId || !modal.title.trim() || typeof modal.metadata?.className !== "string" || !modal.metadata.className) {
			throw new Error("The pending modal lacks a stable identity; no additional input was dispatched.");
		}
		const entry: PendingEntry = { pid, parentWindowId, modalWindowId: modal.windowId, modalTitle: modal.title,
			modalClass: modal.metadata.className, requestId, state: "pending", settled: Promise.resolve() };
		entry.settled = completion.then((result) => {
			if (entry.state !== "uncertain") entry.state = result.outcome === "worked" ? "returned" : "uncertain";
		}, () => { entry.state = "uncertain"; });
		this.entry = entry;
	}

	hasPending(): boolean { return this.entry !== undefined; }

	completion(): "pending" | "returned" | "unknown" | undefined {
		return this.entry?.state === "uncertain" ? "unknown" : this.entry?.state;
	}

	markUncertain(): void { if (this.entry) this.entry.state = "uncertain"; }

	assertNotUncertain(): void {
		if (this.entry?.state === "uncertain") throw new Error("The pending native action became uncertain. Explicit desktop recovery is required; do not replay it.");
	}

	clear(): void { this.entry = undefined; this.monitoring = false; }

	/** Browser writes cannot be attributed to the exact owned native window. */
	async rejectUnscopedWrite(listRoots: (pid: number) => Promise<PlatformRoot[]>): Promise<void> {
		if (!this.entry) return;
		const prior = await this.afterModalWrite(listRoots);
		if (prior && !prior.modalOpen && prior.completion === "returned") return;
		throw new Error("A native action is waiting on a modal window; only the exact observed modal may receive input.");
	}

	private async confirmedClosed(entry: PendingEntry, first: PlatformRoot[], listRoots: (pid: number) => Promise<PlatformRoot[]>): Promise<boolean> {
		const closed = (roots: PlatformRoot[]) => !roots.some((root) => root.pid === entry.pid && root.windowId === entry.modalWindowId)
			&& interaction(roots.find((root) => root.pid === entry.pid && root.windowId === entry.parentWindowId))?.enabled === true;
		if (!closed(first)) return false;
		await new Promise<void>((resolve) => setTimeout(resolve, 75));
		return closed(await listRoots(entry.pid));
	}

	async guardWrite(pid: number, windowId: number, listRoots: (pid: number) => Promise<PlatformRoot[]>): Promise<boolean> {
		const entry = this.entry;
		if (!entry) return false;
		if (entry.state === "uncertain") throw new Error("The pending native action became uncertain. Explicit desktop recovery is required; do not replay it.");
		const roots = await listRoots(entry.pid);
		const modal = roots.find((root) => root.pid === entry.pid && root.windowId === entry.modalWindowId);
		if (!modal) {
			if (!await this.confirmedClosed(entry, roots, listRoots)) throw new Error("The modal's closure could not be confirmed. Do not send further input.");
			// Once the dialog disappears, the original call should be able to
			// return. Keep the fence while its response is outstanding.
			if (entry.state === "pending") {
				let timer: ReturnType<typeof setTimeout> | undefined;
				try { await Promise.race([entry.settled, new Promise<void>((resolve) => { timer = setTimeout(resolve, 5_000); })]); }
				finally { if (timer) clearTimeout(timer); }
			}
			if (entry.state === "returned") {
				const latest = await listRoots(entry.pid);
				if (!await this.confirmedClosed(entry, latest, listRoots)) throw new Error("The modal's closure changed while reconciling the native action. Do not send further input.");
				if (this.entry === entry) this.entry = undefined;
				return false;
			}
			throw new Error("The modal closed but the original native action has not completed. Do not send more input until it is reconciled.");
		}
		const parent = roots.find((root) => root.pid === entry.pid && root.windowId === entry.parentWindowId);
		const info = interaction(modal);
		const sameOwnerWindows = roots.filter((root) => root.pid === entry.pid && root.windowId !== entry.parentWindowId
			&& interaction(root)?.ownerHwnd === entry.parentWindowId && interaction(root)?.enabled === true && root.isOnscreen);
		if (this.entry !== entry || this.completion() === "unknown") throw new Error("The pending native action changed during window validation. Explicit desktop recovery is required.");
		if (pid !== entry.pid || windowId !== entry.modalWindowId || !modal.isOnscreen || modal.isMinimized
			|| modal.title !== entry.modalTitle || modal.metadata?.className !== entry.modalClass
			|| info?.enabled !== true || info.ownerHwnd !== entry.parentWindowId || info.ownerDisabled !== true
			|| interaction(parent)?.enabled !== false || sameOwnerWindows.length !== 1) {
			throw new Error("A native action is pending. Input is restricted to its uniquely identified, still-open modal window.");
		}
		return true;
	}

	/** Reconcile after an action on the modal, including its final close. */
	async afterModalWrite(listRoots: (pid: number) => Promise<PlatformRoot[]>): Promise<PriorModalAction | undefined> {
		const entry = this.entry;
		if (!entry) return undefined;
		let modalOpen = false;
		try {
			const roots = await listRoots(entry.pid);
			modalOpen = roots.some((root) => root.pid === entry.pid && root.windowId === entry.modalWindowId);
			if (!modalOpen && !await this.confirmedClosed(entry, roots, listRoots)) entry.state = "uncertain";
			if (!modalOpen && entry.state === "pending") {
				let timer: ReturnType<typeof setTimeout> | undefined;
				try { await Promise.race([entry.settled, new Promise<void>((resolve) => { timer = setTimeout(resolve, 5_000); })]); }
				finally { if (timer) clearTimeout(timer); }
			}
			if (!modalOpen && entry.state === "returned") {
				const latest = await listRoots(entry.pid);
				if (!await this.confirmedClosed(entry, latest, listRoots)) entry.state = "uncertain";
			}
		} catch { entry.state = "uncertain"; }
		const completion = entry.state === "uncertain" ? "unknown" : entry.state;
		if (!modalOpen && completion === "returned" && this.entry === entry) this.entry = undefined;
		return { requestId: entry.requestId, completion, modalOpen };
	}
}
