import type { MouseButtonName, UiAction } from "./contract.ts";
import type { OutlineNode } from "./outline.ts";
import type { PlatformName } from "./platform/types.ts";
import { toFiniteNumber } from "./platform/coerce.ts";

export type ActionTarget = { ref: string } | { x: number; y: number } | { focus: { x: number; y: number } };

export type PreparedAction =
	| { action: "press" | "click"; target: ActionTarget; params: { button?: MouseButtonName; clickCount?: number }; establishesFocus: boolean; usesCurrentFocus: false; needsForeground: boolean }
	| { action: "setText"; target: ActionTarget; params: { text: string }; establishesFocus: false; usesCurrentFocus: false; needsForeground: false }
	| { action: "typeText"; target: ActionTarget; params: { text: string }; establishesFocus: false; usesCurrentFocus: boolean; needsForeground: false }
	| { action: "keypress"; target: ActionTarget; params: { keys: string[] }; establishesFocus: false; usesCurrentFocus: boolean; needsForeground: false }
	| { action: "scroll"; target: ActionTarget; params: { scrollX: number; scrollY: number }; establishesFocus: false; usesCurrentFocus: false; needsForeground: false }
	| { action: "drag"; target: ActionTarget; params: { path: Array<{ x: number; y: number }> }; establishesFocus: false; usesCurrentFocus: false; needsForeground: false }
	| { action: "moveMouse"; target: ActionTarget; params: Record<string, never>; establishesFocus: false; usesCurrentFocus: false; needsForeground: false }
	| { action: "wait"; params: { ms: number }; establishesFocus: false; usesCurrentFocus: false; needsForeground: false };

export interface ActionState {
	currentFocus: boolean;
}

export interface ActionEnvironment {
	platform: PlatformName;
	headless: boolean;
	image?: { width: number; height: number };
	node(ref: string): OutlineNode;
	center(node: OutlineNode): { x: number; y: number };
	validatePoint(x: number, y: number, label?: string): void;
}

function mouseButton(value: unknown): MouseButtonName {
	return value === "right" || value === "middle" ? value : "left";
}

function clickCount(value: unknown, fallback = 1): number {
	return Math.max(1, Math.min(3, Math.round(toFiniteNumber(value, fallback))));
}

function scrollDelta(value: unknown): number {
	return Math.max(-10_000, Math.min(10_000, Math.round(toFiniteNumber(value, 0))));
}

const macKeyNames = new Set([
	"return", "enter", "tab", "space", " ", "backspace", "delete", "del", "esc", "escape",
	"f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
	"home", "pageup", "page_up", "page down", "pagedown", "page_down", "forwarddelete", "forward_delete", "end",
	"left", "arrowleft", "arrow_left", "right", "arrowright", "arrow_right", "down", "arrowdown", "arrow_down", "up", "arrowup", "arrow_up",
]);

const windowsKeyNames = new Set([
	"enter", "return", "escape", "esc", "tab", "backspace", "delete", "space", "left", "arrowleft", "right", "arrowright",
	"up", "arrowup", "down", "arrowdown", "home", "end", "pageup", "pagedown", "ctrl", "control", "shift", "alt", "option", "cmd", "win", "meta",
]);

const linuxKeyNames = new Set([
	"enter", "return", "tab", "escape", "esc", "backspace", "delete", "space", "left", "up", "right", "down", "home", "end", "pageup", "pagedown",
	"ctrl", "control", "shift", "alt", "option", "meta", "super", "cmd", "command",
]);

function canonicalModifier(platform: PlatformName, key: string): string | undefined {
	switch (platform) {
		case "macos":
			if (["cmd", "command", "meta"].includes(key)) return "cmd";
			if (["ctrl", "control"].includes(key)) return "ctrl";
			if (key === "shift") return "shift";
			if (["option", "alt"].includes(key)) return "alt";
			return undefined;
		case "windows":
			if (["cmd", "win", "meta"].includes(key)) return "win";
			if (["ctrl", "control"].includes(key)) return "ctrl";
			if (key === "shift") return "shift";
			if (["alt", "option"].includes(key)) return "alt";
			return undefined;
		case "linux":
			if (["meta", "super", "cmd", "command"].includes(key)) return "super";
			if (["ctrl", "control"].includes(key)) return "ctrl";
			if (key === "shift") return "shift";
			if (["alt", "option"].includes(key)) return "alt";
			return undefined;
	}
}

function isSingleNativeKey(platform: PlatformName, key: string): boolean {
	if (platform === "macos") return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(key)).length === 1;
	return key.length === 1 && key.charCodeAt(0) <= 0x7f;
}

function isBaseKey(platform: PlatformName, key: string): boolean {
	if (platform === "macos") return macKeyNames.has(key) || isSingleNativeKey(platform, key) || /^f(?:[1-9]|1[0-2])$/.test(key);
	if (platform === "windows") return windowsKeyNames.has(key) || isSingleNativeKey(platform, key) || /^f(?:[1-9]|1\d|2[0-4])$/.test(key);
	return linuxKeyNames.has(key) || isSingleNativeKey(platform, key) || /^f(?:[1-9]|[12]\d|3[0-5])$/.test(key);
}

function normalizeMacChordToken(token: string): string[] | undefined {
	if (!token.includes("+") || token === "+") return undefined;
	const parts = token.split("+").map((part) => part.trim().toLowerCase());
	if (parts.length < 2 || parts.some((part) => !part)) throw new Error("keypress.keys contains an empty key in a chord.");
	const modifiers = parts.slice(0, -1).map((part) => canonicalModifier("macos", part));
	if (modifiers.some((modifier) => !modifier)) return undefined;
	const base = parts.at(-1)!;
	if (!isBaseKey("macos", base) || canonicalModifier("macos", base)) {
		throw new Error(`Unsupported key '${base}' in macOS key chord.`);
	}
	return [...modifiers as string[], base];
}

export function normalizeKeypressKeys(platform: PlatformName, value: unknown): string[] {
	if (!Array.isArray(value) || value.length === 0) throw new Error("keypress.keys must contain at least one key.");
	if (value.some((key) => typeof key !== "string")) throw new Error("keypress.keys entries must be strings.");
	const tokens = value.map((key: string) => key === " " ? key : key.trim().toLowerCase());
	if (tokens.some((key) => !key)) throw new Error("keypress.keys must not contain an empty key.");

	if (platform !== "macos") {
		for (const key of tokens) {
			if (!isBaseKey(platform, key)) throw new Error(`Unsupported ${platform} key '${key}'.`);
		}
		return tokens;
	}

	// macOS accepts both a token array (cmd, o) and a plus-delimited chord token
	// (cmd+o). Preserve the latter as one token because each array entry is also
	// an independently executed chord when the whole array is not one chord.
	if (tokens.length >= 2) {
		const modifiers = tokens.slice(0, -1).map((key) => canonicalModifier("macos", key));
		if (modifiers.every(Boolean)) {
			const base = tokens.at(-1)!;
			if (!isBaseKey("macos", base) || canonicalModifier("macos", base)) {
				throw new Error(`Unsupported macOS key '${base}' after modifier.`);
			}
			return [...modifiers as string[], base];
		}
	}

	return tokens.map((key) => {
		const chord = normalizeMacChordToken(key);
		if (chord) return chord.join("+");
		if (isBaseKey("macos", key) && !canonicalModifier("macos", key)) return key;
		throw new Error(`Unsupported macOS key '${key}'.`);
	});
}

function keys(value: unknown, platform: PlatformName): string[] {
	return normalizeKeypressKeys(platform, value);
}

function path(value: UiAction["path"], env: ActionEnvironment): Array<{ x: number; y: number }> {
	if (!Array.isArray(value) || value.length < 2) throw new Error("drag.path must contain at least two points.");
	return value.map((point, index) => {
		const x = Array.isArray(point) ? toFiniteNumber(point[0], NaN) : toFiniteNumber(point?.x, NaN);
		const y = Array.isArray(point) ? toFiniteNumber(point[1], NaN) : toFiniteNumber(point?.y, NaN);
		env.validatePoint(x, y, `Drag point ${index + 1}`);
		return { x, y };
	});
}

function nativeTarget(action: UiAction, operation: PreparedAction["action"], env: ActionEnvironment): ActionTarget {
	if (action.ref?.trim()) {
		const node = env.node(action.ref.trim());
		const semanticClick = operation === "click" || operation === "press";
		if (semanticClick && node.isTextInput) {
			const point = env.center(node);
			env.validatePoint(point.x, point.y);
			return point;
		}
		const onlyIncidentalActions = node.actions.every((candidate) => candidate === "AXShowMenu" || candidate === "AXScrollToVisible");
		if (node.wireRef && !node.pictureOnly && (!semanticClick || node.canPress || node.canFocus || node.canSetValue || !onlyIncidentalActions)) {
			return { ref: node.wireRef };
		}
		const point = env.center(node);
		env.validatePoint(point.x, point.y);
		return point;
	}
	const x = toFiniteNumber(action.x, NaN);
	const y = toFiniteNumber(action.y, NaN);
	if (Number.isFinite(x) && Number.isFinite(y)) {
		env.validatePoint(x, y);
		return { x, y };
	}
	if (operation === "drag" && action.path?.length) return path(action.path, env)[0];
	throw new Error(`${operation} requires either ref or both x and y.`);
}

function focusedTarget(env: ActionEnvironment): ActionTarget {
	if (!env.image) throw new Error("Focused keyboard input requires an image-bearing state.");
	return { focus: { x: Math.floor(env.image.width / 2), y: Math.floor(env.image.height / 2) } };
}

function containsEditable(node: OutlineNode): boolean {
	if (node.canSetValue || node.role.toLowerCase().includes("text")) return true;
	return node.children.some(containsEditable);
}

export function prepareAction(action: UiAction, state: ActionState, env: ActionEnvironment): PreparedAction {
	const operation = action.action;
	const usesCurrentFocus = !env.headless && state.currentFocus && !action.ref && (operation === "typeText" || operation === "keypress");
	const target = usesCurrentFocus ? focusedTarget(env) : nativeTarget(action, operation, env);
	const establishesFocus = !env.headless && Boolean(action.ref) && (operation === "click" || operation === "press") && containsEditable(env.node(action.ref!));
	const needsForeground = !env.headless && (operation === "click" || operation === "press") && "x" in target;

	switch (operation) {
		case "press":
		case "click": return { action: operation, target, params: { button: mouseButton(action.button), clickCount: clickCount(action.clickCount) }, establishesFocus, usesCurrentFocus: false, needsForeground };
		case "setText": return { action: operation, target, params: { text: action.text ?? "" }, establishesFocus: false, usesCurrentFocus: false, needsForeground: false };
		case "typeText": return { action: operation, target, params: { text: action.text ?? "" }, establishesFocus: false, usesCurrentFocus, needsForeground: false };
		case "keypress": return { action: operation, target, params: { keys: keys(action.keys, env.platform) }, establishesFocus: false, usesCurrentFocus, needsForeground: false };
		case "scroll": return { action: operation, target, params: { scrollX: scrollDelta(action.scrollX), scrollY: scrollDelta(action.scrollY) }, establishesFocus: false, usesCurrentFocus: false, needsForeground: false };
		case "drag": return { action: operation, target, params: { path: path(action.path, env) }, establishesFocus: false, usesCurrentFocus: false, needsForeground: false };
		case "moveMouse": return { action: operation, target, params: {}, establishesFocus: false, usesCurrentFocus: false, needsForeground: false };
	}
}

export function preflightActionSequence(actions: UiAction[], initialFocus: boolean, env: ActionEnvironment): PreparedAction[] {
	// This validates deterministic arguments and predicts how later actions are
	// addressed within the batch. A predicted click focus is not delivery evidence;
	// native outcomes remain authoritative during dispatch.
	const state: ActionState = { currentFocus: initialFocus };
	return actions.map((action) => {
		const prepared = prepareAction(action, state, env);
		if (!env.headless && (prepared.establishesFocus || (prepared.action === "click" && "x" in prepared.target))) {
			state.currentFocus = true;
		}
		return prepared;
	});
}

export function canRetryInForeground(action: PreparedAction, outcome: "worked" | "didnt" | "unknown", headless: boolean): boolean {
	return !headless && outcome === "didnt" && (action.action === "typeText" || action.action === "keypress");
}

export function outcomeAfterCheck(current: "worked" | "didnt" | "unknown", check: "verified" | "preexisting" | "failed"): "worked" | "didnt" | "unknown" {
	if (check === "verified") return "worked";
	if (check === "failed") return "didnt";
	return current;
}

export function outcomeAfterObservedValues(
	current: "worked" | "didnt" | "unknown",
	actions: UiAction[],
	valueForRef: (ref: string) => string | undefined,
): "worked" | "didnt" | "unknown" {
	if (actions.length === 0 || actions.some((action) => action.action !== "setText" || !action.ref)) return current;
	const matches = actions.every((action) => valueForRef(action.ref!) === (action.text ?? ""));
	return matches ? "worked" : current;
}
