import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridge = await readFile(path.join(root, "native/macos/bridge.swift"), "utf8");
assert.match(bridge, /dispatchForegroundEventIfVerified\(report,\s*event:\s*foregroundInputEvent\(event\),\s*dispatch:\s*target\.dispatchState,\s*emit:\s*\{\s*event\.post\(tap:\s*\.cghidEventTap\)/s, "all global HID events must pass the tested foreground gate and per-act event tracker immediately before posting");
assert.match(bridge, /frontmostPidStable:\s*firstPid\s*==\s*secondPid\s*&&\s*secondPid\s*==\s*emitPid/);
assert.match(bridge, /firstDiagnostics:\s*firstResolution\?\.diagnostics/,
	"foreground gate must retain the first AX/CG mapping diagnostics");
assert.match(bridge, /secondDiagnostics:\s*secondResolution\?\.diagnostics/,
	"foreground gate must retain the second AX/CG mapping diagnostics");
assert.match(bridge, /case "focusDiagnostics":/,
	"helper must expose a read-only focus mapping diagnostic");
assert.match(bridge, /focusedWindowResolution\(pid: pid, focused: focused\)\.windowId/,
	"focused window mapping must use one explicit AX/CG resolution contract");
const focusDiagnosticsStart = bridge.indexOf("private func focusDiagnostics(");
const focusDiagnosticsEnd = bridge.indexOf("\n\tprivate func getUserContext", focusDiagnosticsStart);
assert.ok(focusDiagnosticsStart >= 0 && focusDiagnosticsEnd > focusDiagnosticsStart, "focusDiagnostics implementation must remain discoverable");
const focusDiagnosticsSource = bridge.slice(focusDiagnosticsStart, focusDiagnosticsEnd);
assert.match(focusDiagnosticsSource, /let firstPid = NSWorkspace\.shared\.frontmostApplication/,
	"focus diagnostics must read actual frontmost PID independently of requestedPid");
assert.match(focusDiagnosticsSource, /boundedOptionalInt32Arg\(request, "pid"\)/,
	"diagnostic PID must be range checked before conversion");
assert.match(focusDiagnosticsSource, /boundedOptionalUInt32Arg\(request, "windowId"\)/,
	"diagnostic window ID must be range checked before conversion");
assert.match(bridge, /decideFocusedMapping\(focusedToken:/,
	"AX/CG mapping must use the injectable pure decision contract");

const listWindowsStart = bridge.indexOf("private func listWindows(");
const listWindowsEnd = bridge.indexOf("\n\tprivate func look(", listWindowsStart);
assert.ok(listWindowsStart >= 0 && listWindowsEnd > listWindowsStart, "listWindows implementation must remain discoverable");
const listWindowsSource = bridge.slice(listWindowsStart, listWindowsEnd);
assert.match(listWindowsSource, /let focusedWindow = copyAttribute\(appElement,\s*attribute:\s*kAXFocusedWindowAttribute/,
	"listWindows must read the application's focused-window identity");
assert.match(listWindowsSource, /let isFocused = focusedWindow\.map \{ sameElement\(\$0, window\) \} \?\? false/,
	"window focus must come from exact app focused-window identity");
assert.match(listWindowsSource, /\"isFocused\": focusedWindow\.map \{ sameElement\(\$0, sheet\) \} \?\? false/,
	"sheet focus must not inherit its parent window's focus");

const getFrontmostStart = bridge.indexOf("private func getFrontmost()");
const getFrontmostEnd = bridge.indexOf("\n\tprivate func getUserContext", getFrontmostStart);
assert.ok(getFrontmostStart >= 0 && getFrontmostEnd > getFrontmostStart, "getFrontmost implementation must remain discoverable");
const getFrontmostSource = bridge.slice(getFrontmostStart, getFrontmostEnd);
assert.match(getFrontmostSource, /focusedWindowIdentity\(pid:\s*pid\)/,
	"getFrontmost must map the real AX focused window");
assert.doesNotMatch(getFrontmostSource, /scoreWindow|sorted\(/,
	"getFrontmost must not promote a scored window as frontmost proof");

// Combination regression model: an AXFocused attribute is irrelevant when
// the app-level focused window points elsewhere or is unavailable. This is the
// contract implemented by the exact sameElement checks above.
const exactFocus = (focused, candidate) => focused === undefined ? false : focused === candidate;
assert.equal(exactFocus("target", "target"), true, "app focused target must be marked focused");
assert.equal(exactFocus("target", "other"), false, "same-pid wrong window must not be marked focused");
assert.equal(exactFocus(undefined, "target"), false, "missing app focus must remain unconfirmed");
assert.equal(exactFocus("target", "target-sheet"), false, "a sheet must not inherit parent focus");

if (process.platform !== "darwin") {
	console.log("native foreground gate integration source check passed; Swift runtime test requires macOS");
	process.exit(0);
}

const temp = await mkdtemp(path.join(os.tmpdir(), "pi-cu-foreground-gate-"));
try {
	const binary = path.join(temp, "foreground-gate-tests");
	const compile = spawnSync("swiftc", [
		path.join(root, "native/macos/foreground_gate.swift"),
		path.join(root, "native/macos/foreground_gate_tests.swift"),
		"-o",
		binary,
	], { encoding: "utf8" });
	assert.equal(compile.status, 0, compile.stderr || compile.stdout);
	const run = spawnSync(binary, [], { encoding: "utf8" });
	assert.equal(run.status, 0, run.stderr || run.stdout);
	assert.match(run.stdout, /native foreground gate tests passed/);
	console.log(run.stdout.trim());
} finally {
	await rm(temp, { recursive: true, force: true });
}
