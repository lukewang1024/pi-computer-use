import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ensurePermissions, requestPermissions, type PermissionBridge, type PermissionKind, type PermissionStatus } from "../../permissions.ts";
import { toBoolean, toFiniteNumber, toOptionalString } from "../coerce.ts";
import type { PlatformDiagnostics, PlatformReadyState } from "../types.ts";
import { HELPER_APP_PATH, macosHelper } from "./helper.ts";
import { assertPlatformArchitecture } from "../architecture.ts";

const GRANT_INSTRUCTIONS =
	"Grant Accessibility and Screen Recording to pi-computer-use.app in System Settings → Privacy & Security. " +
	"Screen Recording lets the agent see the window; Accessibility lets it interact with the window.";

const SIGNING_MIGRATION_WARNING =
	"A missing permission does not identify why macOS reports it missing. If the helper identity changed, " +
	"macOS may require reviewing the existing grant.";

const PERMISSION_REQUEST_OPTION = "Request missing macOS permissions";
const PERMISSION_RECHECK_OPTION = "Recheck permissions (restart helper)";

const macosPermissionKinds = [
	{ kind: "accessibility" as const, openOption: "Open Accessibility Settings (missing)" },
	{ kind: "screenRecording" as const, openOption: "Open Screen Recording Settings (missing)" },
];

function permissionStatusSummary(status: PermissionStatus): string {
	const lines = [
		`Accessibility: ${status.accessibility ? "granted" : "missing"}`,
		`Screen Recording: ${status.screenRecording ? "granted" : "missing"}`,
	];
	if (status.screenRecordingPreflight && !status.screenRecording) {
		lines.push(
			"(Screen Recording reads granted in the TCC database but a live capture probe failed — " +
			"the grant likely belongs to a different app identity, or the helper needs a restart.)",
		);
	}
	return lines.join("; ");
}

function permissionPrompt(status: PermissionStatus, helperPath: string, hint?: string): string {
	const attributionWarning = status.source?.attribution === "caller"
		? `Warning: the helper is not running as the installed pi-computer-use.app (executable: ${status.source.executablePath ?? "unknown"}). Grants may attach to the launching app instead.`
		: undefined;
	return [
		"Explicitly manage missing macOS permissions for the pi-computer-use helper.",
		permissionStatusSummary(status),
		"",
		`Helper: pi-computer-use.app (${helperPath})`,
		attributionWarning,
		hint,
		"",
		SIGNING_MIGRATION_WARNING,
		"",
		"A request is made only if you select the explicit request option below.",
	].filter(Boolean).join("\n");
}

function missingPermissionMessage(kinds: PermissionKind[]): string {
	return `Still missing: ${kinds.join(" and ")}. Grant the listed permissions in System Settings, then run /computer-use permissions to check again.`;
}

async function checkPermissions(signal?: AbortSignal): Promise<PermissionStatus> {
	const result = await macosHelper.command<any>("checkPermissions", {}, { signal });
	const rawSource = result?.source;
	return {
		accessibility: toBoolean(result?.accessibility),
		// Authoritative: the helper's live ScreenCaptureKit probe.
		screenRecording: toBoolean(result?.screenRecordingCapturable),
		// Keep the preflight value separate: disagreement means stale per-process
		// TCC cache or a grant row belonging to another app identity.
		screenRecordingPreflight: toBoolean(result?.screenRecordingPreflight),
		source: rawSource && typeof rawSource === "object"
			? {
				// macOS attributes Accessibility / Screen Recording grants to the
				// responsible process at the top of the launch chain. "helper-app"
				// is the canonical installed app via LaunchServices; "caller" means
				// grants would attach to the launching app instead.
				attribution: rawSource.attribution === "helper-app" ? "helper-app" : "caller",
				pid: Math.trunc(toFiniteNumber(rawSource.pid, 0)) || undefined,
				parentPid: Math.trunc(toFiniteNumber(rawSource.parentPid, 0)) || undefined,
				executablePath: toOptionalString(rawSource.executablePath),
				parentPath: toOptionalString(rawSource.parentPath),
				parentBundleId: toOptionalString(rawSource.parentBundleId),
				os: toOptionalString(rawSource.macOS),
			}
			: undefined,
	};
}

async function registerPermissions(signal?: AbortSignal): Promise<void> {
	// Raises the Accessibility prompt and performs a real ScreenCaptureKit
	// capture attempt so pi-computer-use.app is pre-listed in both Settings
	// panes; the user only flips toggles, no "+" path picking.
	await macosHelper.command("registerPermissions", {}, { signal, timeoutMs: 15_000 });
}

function macosPermissionBridge(): PermissionBridge {
	return {
		kinds: macosPermissionKinds,
		copy: {
			nonInteractiveError: (helperPath) => `pi-computer-use permissions are missing. In an interactive Pi session, run /computer-use permissions to explicitly request them. Helper path: ${helperPath}`,
			prompt: permissionPrompt,
			incompleteError: (helperPath) => `pi-computer-use permissions are missing. This readiness check did not request them. Run /computer-use permissions to explicitly request or open the relevant settings pane. ${GRANT_INSTRUCTIONS} Helper path: ${helperPath}`,
			requestOption: PERMISSION_REQUEST_OPTION,
			recheckOption: PERMISSION_RECHECK_OPTION,
			readyMessage: "pi-computer-use is ready.",
			stillMissing: missingPermissionMessage,
		},
		checkPermissions,
		registerPermissions,
		openPermissionPane: async (kind, signal) => {
			await macosHelper.command("openPermissionPane", { kind }, { signal, timeoutMs: 15_000 });
		},
		restartHelper: (signal) => macosHelper.restart(signal),
		permissionHint: undefined,
	};
}

async function ensureHelperAvailable(signal?: AbortSignal): Promise<PlatformDiagnostics> {
	await macosHelper.ensureInstalled(signal);
	if (!(await macosHelper.ensureDaemon(signal))) {
		throw new Error(`pi-computer-use helper app daemon did not start. Helper app: ${HELPER_APP_PATH}`);
	}
	const helperDiagnostics = await macosHelper.ensureProtocol(signal);
	assertPlatformArchitecture("macOS", helperDiagnostics);
	return helperDiagnostics;
}

/** Explicit entry point used by the `/computer-use permissions` command. */
export async function requestMacosPermissions(ctx: ExtensionContext, signal?: AbortSignal): Promise<PermissionStatus> {
	if (!ctx.hasUI) {
		throw new Error(`Permission requests require an interactive Pi session. Run /computer-use permissions in an interactive session. Helper path: ${HELPER_APP_PATH}`);
	}
	await ensureHelperAvailable(signal);
	return await requestPermissions(ctx, macosPermissionBridge(), HELPER_APP_PATH, signal);
}

export async function ensureMacosReady(
	ctx: ExtensionContext,
	state: PlatformReadyState,
	signal?: AbortSignal,
): Promise<PlatformReadyState> {
	const helperDiagnostics = await ensureHelperAvailable(signal);

	const now = Date.now();
	const cachedStatus = state.permissionStatus;
	const canUseCachedPermissions =
		cachedStatus?.accessibility &&
		cachedStatus.screenRecording &&
		now - state.lastPermissionCheckAt < 2_000;
	if (canUseCachedPermissions) {
		return { ...state, helperDiagnostics };
	}

	const permissionStatus = await ensurePermissions(ctx, macosPermissionBridge(), HELPER_APP_PATH, signal);

	return { permissionStatus, lastPermissionCheckAt: Date.now(), helperDiagnostics };
}
