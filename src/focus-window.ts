export interface FocusWindowIdentity {
	pid: number;
	windowId?: number;
	rootRef?: string;
	windowRef?: string;
}

export interface FocusWindowRootObservation {
	pid?: number;
	windowId?: number;
	rootRef?: string;
	windowRef?: string;
	isMain?: boolean;
	isFocused?: boolean;
}

export interface FocusWindowFrontmostObservation {
	pid: number;
	windowId?: number;
	rootRef?: string;
	windowRef?: string;
}

export interface FocusWindowVerification {
	verified: boolean;
	targetIsMain: boolean;
	targetIsFocused: boolean;
	frontmostPidMatches: boolean;
	frontmostWindowMatches: boolean;
}

/** Verify the exact requested root, not merely another window in its process. */
export function verifyFocusedWindow(
	target: FocusWindowIdentity,
	roots: FocusWindowRootObservation[],
	frontmost?: FocusWindowFrontmostObservation,
): FocusWindowVerification {
	const root = roots.find((candidate) => {
		if (candidate.pid !== target.pid) return false;
		if (target.windowId && candidate.windowId) return candidate.windowId === target.windowId;
		const targetRef = target.rootRef ?? target.windowRef;
		return Boolean(targetRef && (candidate.rootRef === targetRef || candidate.windowRef === targetRef));
	});
	const targetIsMain = root?.isMain === true;
	const targetIsFocused = root?.isFocused === true;
	const frontmostPidMatches = frontmost?.pid === target.pid;
	const targetRef = target.rootRef ?? target.windowRef;
	const frontmostRef = frontmost?.rootRef ?? frontmost?.windowRef;
	const frontmostWindowMatches = target.windowId !== undefined && target.windowId > 0
		? frontmost?.windowId === target.windowId
		: Boolean(targetRef && frontmostRef === targetRef);
	return {
		verified: targetIsMain && targetIsFocused && frontmostPidMatches && frontmostWindowMatches,
		targetIsMain,
		targetIsFocused,
		frontmostPidMatches,
		frontmostWindowMatches,
	};
}
