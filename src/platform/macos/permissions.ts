import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ensurePermissions, requestPermissions, type PermissionBridge, type PermissionKind, type PermissionStatus } from "../../permissions.ts";
import { parseMacosPermissionStatus } from "./permission-status.ts";
import type { PlatformDiagnostics, PlatformReadyState } from "../types.ts";
import { HELPER_APP_PATH, macosHelper } from "./helper.ts";
import { assertPlatformArchitecture } from "../architecture.ts";

const GRANT_INSTRUCTIONS =
	"Grant Accessibility and Screen Recording to pi-computer-use.app in System Settings → Privacy & Security. " +
	"Screen Recording lets the agent see the window; Accessibility lets it interact with the window.";

const SIGNING_MIGRATION_WARNING =
	"A missing permission does not identify why macOS reports it missing. If the helper identity changed, " +
	"macOS may require reviewing the existing grant.";

const PERMISSION_REQUEST_OPTION = "Request macOS permissions / direct screenshot access";
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
	if (status.captureReadiness === "not-probed") {
		lines.push("Direct screenshot access: not tested; capture may require a separate system confirmation.");
	}
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
		"Explicitly manage macOS permissions and optional direct screenshot access.",
		permissionStatusSummary(status),
		"",
		`Helper: pi-computer-use.app (${helperPath})`,
		attributionWarning,
		hint,
		"",
		SIGNING_MIGRATION_WARNING,
		"",
		"A request is made only if you select the explicit request option below.",
		"A direct screenshot probe may show a separate system confirmation even when basic recording permission is granted.",
	].filter(Boolean).join("\n");
}

function missingPermissionMessage(kinds: PermissionKind[]): string {
	return `Still missing: ${kinds.join(" and ")}. Grant the listed permissions in System Settings, then run /computer-use permissions to check again.`;
}

async function checkPermissions(signal?: AbortSignal): Promise<PermissionStatus> {
	const result = await macosHelper.command<any>("checkPermissions", {}, { signal });
	return parseMacosPermissionStatus(result);
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
			readyMessage: "macOS permission checks completed. Direct screenshot access is verified only by an actual capture.",
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

	// Accessibility gates semantic/native operations. Screen Recording is reported
	// independently and enforced by image capture itself, never by a global live probe.
	const permissionStatus: PermissionStatus = {
		accessibility: helperDiagnostics.accessibility === true,
		screenRecording: helperDiagnostics.screenRecording === true,
		screenRecordingPreflight: helperDiagnostics.screenRecording === true,
		captureReadiness: "not-probed",
	};
	if (!permissionStatus.accessibility) throw new Error(`Accessibility is unavailable for the helper. Readiness did not request permission. Helper path: ${HELPER_APP_PATH}`);
	return { permissionStatus, lastPermissionCheckAt: Date.now(), helperDiagnostics };
}
