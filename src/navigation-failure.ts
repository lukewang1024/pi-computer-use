/** Evidence about this CDP call only; not permission to retry or recover a desktop. */
export class CdpNavigationFailure extends Error {
	readonly navigationFailure = Object.freeze({
		version: 1,
		mechanism: "cdp",
		command: "Page.navigate",
		phase: "navigation",
		physicalInputDispatched: false,
		navigationOutcome: "unknown",
		retrySafe: false,
	} as const);
	constructor(cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause), { cause });
		this.name = "CdpNavigationFailure";
	}
}

/** Only the launch catch may emit this after its owned browser has closed. */
export class ManagedLaunchNavigationFailure extends Error {
	readonly launchFailure = Object.freeze({
		version: 1, tool: "launch_browser", phase: "navigation",
		physicalInputDispatched: false, navigationOutcome: "unknown",
		ownedBrowserClosed: true, ownedProfileRemoved: true,
		ownershipReleased: true, retrySafe: false,
	} as const);
	constructor(cause: CdpNavigationFailure) {
		super(cause.message, { cause });
		this.name = "ManagedLaunchNavigationFailure";
	}
}
