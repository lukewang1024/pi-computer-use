import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { verifyFocusedWindow } from "../src/focus-window.ts";

const target = { pid: 42, windowId: 7, windowRef: "native-window-7" };
const focusedTarget = { ...target, isMain: true, isFocused: true };
const otherWindow = { pid: 42, windowId: 8, windowRef: "native-window-8", isMain: true, isFocused: true };

assert.equal(verifyFocusedWindow(target, [focusedTarget], { pid: 42, windowId: 7 }).verified, true);
assert.equal(verifyFocusedWindow(target, [otherWindow], { pid: 42, windowId: 8 }).verified, false);
assert.equal(verifyFocusedWindow(target, [focusedTarget], { pid: 99 }).verified, false);
assert.equal(verifyFocusedWindow(target, [focusedTarget], { pid: 42 }).verified, false, "a matching process without the exact frontmost window id is insufficient");
assert.equal(verifyFocusedWindow(target, [{ ...focusedTarget, isFocused: false }], { pid: 42, windowId: 7 }).verified, false);
assert.equal(verifyFocusedWindow(target, [{ ...focusedTarget, isMain: false }], { pid: 42, windowId: 7 }).verified, false);
assert.equal(verifyFocusedWindow({ pid: 42, windowRef: "native-window-7" }, [focusedTarget], { pid: 42, windowRef: "native-window-7" }).verified, true);
assert.equal(verifyFocusedWindow({ pid: 42, windowRef: "native-window-7" }, [focusedTarget], { pid: 42 }).verified, false, "a root without a window id still requires an exact frontmost native ref");

const bridgeSource = await readFile(new URL("../src/bridge.ts", import.meta.url), "utf8");
const frontmostStart = bridgeSource.indexOf("async function resolveFrontmostTarget");
const frontmostEnd = bridgeSource.indexOf("\nasync function resolveTargetForObserve", frontmostStart);
assert.ok(frontmostStart >= 0 && frontmostEnd > frontmostStart, "frontmost target resolver must remain discoverable");
const frontmostResolver = bridgeSource.slice(frontmostStart, frontmostEnd);
assert.match(frontmostResolver, /currentPlatformBackend\.name === "macos"[\s\S]*frontmost AX focused-window identity was unavailable/,
	"macOS must fail closed when the native focused-window identity is missing");
assert.match(frontmostResolver, /frontmostRef[\s\S]*window\.rootRef === frontmostRef/,
	"frontmost resolution must accept only the native root identity when no window id is available");
console.log("focus-window verification tests passed");
