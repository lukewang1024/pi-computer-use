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
