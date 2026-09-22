import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// Which process identity the permission answers reflect. Platforms may
// attribute grants to a responsible parent process rather than the helper
// executable itself.
export type PermissionAttribution = "helper-app" | "caller";
export type PermissionKind = "accessibility" | "screenRecording";

export interface PermissionSource {
	attribution: PermissionAttribution;
	pid?: number;
	parentPid?: number;
	executablePath?: string;
	parentPath?: string;
	parentBundleId?: string;
	os?: string;
}

export interface PermissionStatus {
	accessibility: boolean;
	screenRecording: boolean;
	screenRecordingPreflight?: boolean;
	source?: PermissionSource;
}

interface PermissionKindCopy {
	kind: PermissionKind;
	openOption: string;
}

interface PermissionFlowCopy {
	nonInteractiveError(helperPath: string): string;
	prompt(status: PermissionStatus, helperPath: string, hint?: string): string;
	incompleteError(helperPath: string): string;
	requestOption: string;
	recheckOption: string;
	readyMessage: string;
	stillMissing(kinds: PermissionKind[]): string;
}

export interface PermissionBridge {
	kinds: PermissionKindCopy[];
	copy: PermissionFlowCopy;
	checkPermissions(signal?: AbortSignal): Promise<PermissionStatus>;
	registerPermissions(signal?: AbortSignal): Promise<void>;
	openPermissionPane(kind: PermissionKind, signal?: AbortSignal): Promise<void>;
	// Platforms may cache permission answers per process, so restart before
	// recheck lets a new grant become visible to the helper.
	restartHelper(signal?: AbortSignal): Promise<void>;
	permissionHint?: string;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Operation aborted.");
}

function granted(status: PermissionStatus, kind: PermissionKind): boolean {
	return status[kind] === true;
}

function allGranted(status: PermissionStatus, kinds: PermissionKindCopy[]): boolean {
	return kinds.every(({ kind }) => granted(status, kind));
}

function missingKinds(status: PermissionStatus, kinds: PermissionKindCopy[]): PermissionKind[] {
	return kinds.flatMap(({ kind }) => granted(status, kind) ? [] : [kind]);
}

export async function ensurePermissions(
	ctx: ExtensionContext,
	bridge: PermissionBridge,
	helperPath: string,
	signal?: AbortSignal,
): Promise<PermissionStatus> {
	const status = await bridge.checkPermissions(signal);
	if (allGranted(status, bridge.kinds)) return status;

	if (!ctx.hasUI) throw new Error(bridge.copy.nonInteractiveError(helperPath));
	throw new Error(bridge.copy.incompleteError(helperPath));
}

/**
 * Request permissions only after an explicit UI action calls this function.
 * Ordinary readiness checks must use ensurePermissions, which never registers
 * the helper or opens System Settings.
 */
export async function requestPermissions(
	ctx: ExtensionContext,
	bridge: PermissionBridge,
	helperPath: string,
	signal?: AbortSignal,
): Promise<PermissionStatus> {
	let status = await bridge.checkPermissions(signal);
	if (allGranted(status, bridge.kinds)) {
		if (ctx.hasUI) ctx.ui.notify(bridge.copy.readyMessage, "info");
		return status;
	}

	if (!ctx.hasUI) throw new Error(bridge.copy.nonInteractiveError(helperPath));

	throwIfAborted(signal);
	const missing = missingKinds(status, bridge.kinds);
	const options = [
		bridge.copy.requestOption,
		bridge.copy.recheckOption,
		...bridge.kinds
			.filter(({ kind }) => missing.includes(kind))
			.map(({ openOption }) => openOption),
		"Cancel",
	];
	const choice = await ctx.ui.select(bridge.copy.prompt(status, helperPath, bridge.permissionHint), options, { signal });
	if (!choice || choice === "Cancel") return status;

	if (choice === bridge.copy.requestOption) {
		await bridge.registerPermissions(signal);
		status = await bridge.checkPermissions(signal);
	} else if (choice === bridge.copy.recheckOption) {
		await bridge.restartHelper(signal);
		status = await bridge.checkPermissions(signal);
	} else {
		const selected = bridge.kinds.find(({ openOption }) => choice === openOption);
		if (!selected) return status;
		await bridge.openPermissionPane(selected.kind, signal);
		status = await bridge.checkPermissions(signal);
	}

	if (allGranted(status, bridge.kinds)) {
		ctx.ui.notify(bridge.copy.readyMessage, "info");
	} else {
		ctx.ui.notify(bridge.copy.stillMissing(missingKinds(status, bridge.kinds)), "warning");
	}

	return status;
}
