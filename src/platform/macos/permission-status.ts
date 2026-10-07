import type { PermissionStatus } from "../../permissions.ts";
import { toBoolean, toFiniteNumber, toOptionalString } from "../coerce.ts";

export function parseMacosPermissionStatus(result: any): PermissionStatus {
	const rawSource = result?.source;
	const notProbed = result?.captureReadiness === "not-probed";
	return {
		accessibility: toBoolean(result?.accessibility),
		// New helpers report basic preflight only; retain legacy live-result parsing.
		screenRecording: notProbed ? toBoolean(result?.screenRecordingPreflight) : toBoolean(result?.screenRecordingCapturable),
		captureReadiness: notProbed ? "not-probed" : undefined,
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
