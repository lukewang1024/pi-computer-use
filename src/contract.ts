export type RootSelector = string;
export type ImageMode = "auto" | "always" | "never";
export type MouseButtonName = "left" | "right" | "middle";

export interface ObserveTargetParams {
	root?: RootSelector;
}

export interface FindParams {
	text?: string;
	app?: string;
	bundleId?: string;
	pid?: number;
	/** Filters on the platform's best-effort presentation hint; only window vs transient is guaranteed. */
	kind?: "window" | "menu" | "sheet" | "popover" | "dialog" | "browser_page";
}

export interface FocusWindowParams {
	/** Optional observation after focus. Defaults to false; failure never erases the focus receipt. */
	capture?: boolean;
	/** Exact @r ref returned by find_roots. */
	root: RootSelector;
}

export interface StateTargetParams {
	stateId?: string;
}

export interface NavigateBrowserParams extends StateTargetParams {
	url: string;
	/** Collect bounded navigation/paint/observer metrics before the successor snapshot. */
	includePerformance?: boolean;
}

export interface LaunchBrowserParams {
	url?: string;
}

export interface EvaluateBrowserParams {
	stateId: string;
	expression: string;
}

export interface ObserveParams extends ObserveTargetParams {
	mode?: "semantic" | "visual" | "fused" | "pixels";
	/** Opt-in macOS focused-element diagnosis; never grants input authority. */
	focusContext?: boolean;
	/** Internal capture override; not part of the model-facing schema. */
	readText?: "auto" | "always" | "never";
}

export interface SearchUiParams extends StateTargetParams {
	text?: string;
	role?: string;
	capability?: string;
}

export interface ExpandUiParams extends StateTargetParams {
	ref: string;
	depth?: number;
}

export interface InspectUiParams extends StateTargetParams {
	ref: string;
}

export interface UiCondition {
	ref?: string;
	scopeRef?: string;
	text?: string;
	role?: string;
	value?: string;
	until?: "present" | "absent";
	timeoutMs?: number;
}

export interface UiAction {
	action: "selectText" | "invoke" | "commit" | "press" | "click" | "setText" | "typeText" | "keypress" | "scroll" | "drag" | "moveMouse";
	ref?: string;
	x?: number;
	y?: number;
	text?: string;
	/** Exact full editable value observed before a native selection. */
	expectedValue?: string;
	selectionMode?: "range" | "start" | "end";
	keys?: string[];
	scrollX?: number;
	scrollY?: number;
	path?: Array<{ x: number; y: number } | [number, number]>;
	button?: MouseButtonName;
	clickCount?: number;
}

export interface ActParams extends StateTargetParams {
	actions: UiAction[];
	expect?: UiCondition;
	/** Desktop successor observation only; input delivery and focus guards are unchanged. */
	observationMode?: "semantic" | "fused";
}

export interface ReadTextParams extends StateTargetParams {
	ref: string;
	offset?: number;
}

export interface WaitForParams extends StateTargetParams, UiCondition {}

export const AGENT_TOOL_NAMES = new Set([
	"find_roots",
	"focus_window",
	"read_text",
	"wait_for",
	"observe_ui",
	"search_ui",
	"expand_ui",
	"inspect_ui",
	"act_ui",
	"navigate_browser",
	"evaluate_browser",
	"launch_browser",
]);
