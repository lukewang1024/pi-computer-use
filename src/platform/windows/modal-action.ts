import type { HelperActResult, ModalActionResult, PlatformRoot } from "../types.ts";
import type { WindowsActionStage } from "./action-diagnostics.ts";
import { ActionPreflightError } from "../../action-preflight.ts";

/** Require stable window identity and ownership without special-casing app or title names. */
export function associatedModal(
	before: PlatformRoot[], after: PlatformRoot[], pid: number, parentWindowId: number,
): PlatformRoot | undefined {
	const interaction = (root: PlatformRoot | undefined): Record<string, unknown> | undefined => {
		const value = root?.metadata?.interaction;
		return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
	};
	const previousParent = before.find((root) => root.pid === pid && root.windowId === parentWindowId);
	const currentParent = after.find((root) => root.pid === pid && root.windowId === parentWindowId);
	if (interaction(previousParent)?.enabled !== true || interaction(currentParent)?.enabled !== false) return undefined;
	const oldWindows = new Set(before.filter((root) => root.pid === pid).map((root) => root.windowId));
	const candidates = after.filter((root) => {
		const properties = interaction(root);
		return root.pid === pid && Number.isSafeInteger(root.windowId) && root.windowId! > 0
			&& !oldWindows.has(root.windowId) && root.isOnscreen && !root.isMinimized
			&& root.title.trim().length > 0 && typeof root.metadata?.className === "string" && root.metadata.className.length > 0
			&& properties?.enabled === true && properties.ownerHwnd === parentWindowId
			&& properties.ownerDisabled === true;
	});
	return candidates.length === 1 ? candidates[0] : undefined;
}

interface ModalActionOptions {
	pid: number;
	parentWindowId: number;
	timeoutMs: number;
	signal?: AbortSignal;
	listRoots(signal?: AbortSignal): Promise<PlatformRoot[]>;
	act(options: {
		signal: AbortSignal;
		timeoutMs: number;
		onRequestId(id: string): void;
		onStage(stage: WindowsActionStage): void;
	}): Promise<HelperActResult>;
}

const MODAL_POLL_MS = 75;
// A dialog may need interaction for longer than the ordinary action timeout.
// This remains bounded: expiry is an unknown result, never a retry.
const MODAL_ACTION_LIMIT_MS = 5 * 60_000;

function pause(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Race a single UIA action against a unique, newly owned modal. The action is
 * always sent exactly once. Diagnostic progress is only a necessary filter;
 * it is not an acknowledgment that the provider received input.
 */
export async function actWithOwnedModal(options: ModalActionOptions): Promise<ModalActionResult> {
	if (options.signal?.aborted) throw new Error("Operation aborted before dispatch.");
	let before: PlatformRoot[];
	try {
		before = await options.listRoots(options.signal);
	} catch {
		// Do not send a mutation while the failed baseline read may still hold
		// the helper's shared native state. The action itself was not sent.
		if (options.signal?.aborted) throw new Error("Operation aborted before dispatch.");
		throw new ActionPreflightError("Could not read the window baseline before the action; no input was sent.", "observe_ui");
	}
	if (options.signal?.aborted) throw new Error("Operation aborted before dispatch.");
	const parent = before.find((root) => root.pid === options.pid && root.windowId === options.parentWindowId);
	const parentInteraction = parent?.metadata?.interaction as Record<string, unknown> | undefined;
	if (!parent || parentInteraction?.enabled !== true) {
		return { kind: "completed", result: await options.act({
			signal: options.signal ?? new AbortController().signal,
			timeoutMs: options.timeoutMs,
			onRequestId: () => {}, onStage: () => {},
		}) };
	}

	const controller = new AbortController();
	const onAbort = () => controller.abort();
	options.signal?.addEventListener("abort", onAbort, { once: true });
	if (options.signal?.aborted) controller.abort();
	let requestId: string | undefined;
	let mutationStarted = false;
	let mutationReturned = false;
	let settled = false;
	let initialTimedOut = false;
	let watching = true;
	const timer = setTimeout(() => { initialTimedOut = true; controller.abort(); }, options.timeoutMs);
	const completion = options.act({
		signal: controller.signal,
		timeoutMs: Math.max(options.timeoutMs, MODAL_ACTION_LIMIT_MS),
		onRequestId: (id) => { requestId = id; },
		onStage: ({ stage }) => {
			if (stage === "native_mutation_started") mutationStarted = true;
			if (stage === "native_mutation_returned") mutationReturned = true;
		},
	}).catch((error: unknown) => {
		if (initialTimedOut && error instanceof Error && (error as Error & { code?: string }).code === "helper_transport_unknown") {
			error.message = `Helper command 'act' timed out after ${options.timeoutMs}ms; command outcome is unknown.`;
		}
		throw error;
	}).finally(() => {
		settled = true;
		watching = false;
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
	});
	const completed = completion.then(
		(result) => ({ kind: "completed" as const, result }),
		(error: unknown) => ({ kind: "failed" as const, error }),
	);
	const observed = (async (): Promise<{ kind: "modal_pending"; modal: PlatformRoot; requestId: string } | undefined> => {
		let previous: { windowId: number; title: string; className: string } | undefined;
		while (watching && !controller.signal.aborted) {
			if (!mutationStarted || mutationReturned || !requestId) {
				await pause(MODAL_POLL_MS);
				continue;
			}
			let roots: PlatformRoot[];
			try { roots = await options.listRoots(controller.signal); }
			catch { return undefined; }
			if (!watching || settled || mutationReturned || controller.signal.aborted) return undefined;
			const modal = associatedModal(before, roots, options.pid, options.parentWindowId);
			const className = typeof modal?.metadata?.className === "string" ? modal.metadata.className : undefined;
			if (modal && modal.windowId && className && previous?.windowId === modal.windowId
				&& previous.title === modal.title && previous.className === className) return { kind: "modal_pending", modal, requestId };
			previous = modal?.windowId && className ? { windowId: modal.windowId, title: modal.title, className } : undefined;
			await pause(MODAL_POLL_MS);
		}
		return undefined;
	})();
	const observation = (async () => {
		// Observer failures after dispatch must not discard the original call.
		const candidate = await observed.catch(() => undefined);
		return candidate ?? await completed;
	})();
	const first = await Promise.race([completed, observation]);
	if (first.kind === "modal_pending" && !settled && !controller.signal.aborted) {
		watching = false;
		clearTimeout(timer);
		return { kind: "modal_pending", pending: { requestId: first.requestId, modal: first.modal, completion } };
	}
	watching = false;
	const result = first.kind === "modal_pending" ? await completed : first;
	if (result.kind === "failed") throw result.error;
	return result;
}
