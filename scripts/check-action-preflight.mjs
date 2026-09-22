import assert from "node:assert/strict";
import { canRetryInForeground, normalizeKeypressKeys, outcomeAfterCheck, preflightActionSequence, prepareAction } from "../src/actions.ts";
import { ResourceScheduler, StaleResourceStateError, runPreflightWrite } from "../src/runtime.ts";

const env = {
	platform: "macos",
	headless: false,
	image: { width: 100, height: 100 },
	node() { throw new Error("unexpected outline lookup"); },
	center() { return { x: 50, y: 50 }; },
	validatePoint(x, y) {
		if (x < 0 || y < 0 || x > 100 || y > 100) throw new Error("point outside observed image");
	},
};
const key = "window:test-transaction";
const scheduler = new ResourceScheduler();
let nativeDispatches = 0;

async function transact(actions, baseEpoch = 0) {
	return await runPreflightWrite(
		scheduler,
		key,
		baseEpoch,
		() => { preflightActionSequence(actions, false, env); },
		async (nextEpoch) => {
			// Mirror the production dispatcher: prepare again while walking the batch,
			// and count only actions that cross this native-dispatch boundary.
			const state = { currentFocus: false };
			const prepared = [];
			for (const action of actions) {
				const step = prepareAction(action, state, env);
				prepared.push(step);
				nativeDispatches += 1;
				if (step.establishesFocus || (step.action === "click" && "x" in step.target)) state.currentFocus = true;
			}
			return { nextEpoch, prepared, outcome: "unknown" };
		},
	);
}

await assert.rejects(
	transact([{ action: "keypress", keys: ["TAB"] }]),
	/requires either ref or both x and y/,
);
assert.equal(scheduler.epoch(key), 0, "an invalid first action must not consume the real scheduler epoch");
assert.equal(nativeDispatches, 0, "an invalid first action must not cross the native dispatch boundary");

await assert.rejects(
	transact([{ action: "click", x: 20, y: 30 }, { action: "press" }]),
	/requires either ref or both x and y/,
);
assert.equal(scheduler.epoch(key), 0, "an invalid later action must prevent the whole batch from consuming an epoch");
assert.equal(nativeDispatches, 0, "an invalid later action must prevent every native dispatch in the batch");

for (const keys of [["super", "o"], ["super+o"], ["cmd", "unknown-key"], [""]]) {
	await assert.rejects(
		transact([{ action: "keypress", x: 20, y: 30, keys }]),
		/Unsupported macOS key|must not contain an empty key/,
	);
	assert.equal(scheduler.epoch(key), 0, "an invalid macOS key must not consume the real scheduler epoch");
	assert.equal(nativeDispatches, 0, "an invalid macOS key must not cross the native dispatch boundary");
}
await assert.rejects(
	transact([{ action: "click", x: 20, y: 30 }, { action: "keypress", keys: ["super", "o"] }]),
	/Unsupported macOS key/,
);
assert.equal(scheduler.epoch(key), 0, "an unsupported later key must reject the entire batch before epoch advance");
assert.equal(nativeDispatches, 0, "an unsupported later key must prevent even the preceding click from dispatching");
await assert.rejects(transact([{ action: "keypress", x: 20, y: 30, keys: [] }]), /at least one key/);
assert.equal(scheduler.epoch(key), 0, "an empty key array must not consume the real scheduler epoch");
assert.equal(nativeDispatches, 0, "an empty key array must not cross the native dispatch boundary");

assert.deepEqual(normalizeKeypressKeys("macos", ["command", "O"]), ["cmd", "o"], "macOS Command aliases should normalize without changing chord semantics");
assert.deepEqual(normalizeKeypressKeys("macos", ["meta+o"]), ["cmd+o"], "the existing macOS plus-delimited chord form should remain supported");
assert.deepEqual(normalizeKeypressKeys("macos", ["cmd+o", "shift+tab"]), ["cmd+o", "shift+tab"], "separate plus-delimited chord tokens should remain separate keypresses");
assert.deepEqual(normalizeKeypressKeys("macos", ["👨‍👩‍👧‍👦"]), ["👨‍👩‍👧‍👦"], "single macOS grapheme keys should remain accepted by the native Unicode path");
assert.deepEqual(normalizeKeypressKeys("macos", [" "]), [" "], "literal Space remains a supported native key");
assert.deepEqual(normalizeKeypressKeys("windows", ["WIN", "O"]), ["win", "o"], "Windows Win-key chords should match the native alias table");
assert.throws(() => normalizeKeypressKeys("windows", ["cmd+o"]), /Unsupported windows key/, "Windows must reject the macOS-only plus chord syntax");
assert.deepEqual(normalizeKeypressKeys("windows", ["F24"]), ["f24"], "Windows should retain its highest supported function key");
assert.throws(() => normalizeKeypressKeys("windows", ["f25"]), /Unsupported windows key/, "Windows should reject function keys outside the native table");
assert.deepEqual(normalizeKeypressKeys("linux", ["super", "o"]), ["super", "o"], "Linux Super chords should match the native alias table");
assert.deepEqual(normalizeKeypressKeys("linux", ["command", "o"]), ["command", "o"], "Linux Command alias should remain accepted as the native Super keysym");
assert.deepEqual(normalizeKeypressKeys("linux", ["f35"]), ["f35"], "Linux should retain its highest supported function key");
assert.throws(() => normalizeKeypressKeys("linux", ["unknown-key"]), /Unsupported linux key/, "unknown Linux key names should fail preflight");
assert.deepEqual(normalizeKeypressKeys("macos", ["f12"]), ["f12"], "macOS should retain its highest supported function key");
assert.throws(() => normalizeKeypressKeys("macos", ["f13"]), /Unsupported macOS key/, "macOS should reject function keys outside the native table");

const legal = await transact([
	{ action: "click", x: 20, y: 30 },
	{ action: "keypress", keys: ["TAB"] },
]);
assert.equal(legal.epoch, 1);
assert.equal(legal.value.nextEpoch, 1);
assert.equal(legal.value.prepared.length, 2);
assert.deepEqual(legal.value.prepared[1].target, { focus: { x: 50, y: 50 } }, "the predicted focus selects a target for the later keypress");
assert.equal(legal.value.outcome, "unknown", "the test does not treat predicted focus or dispatch as proof of success");
assert.equal(nativeDispatches, 2, "a structurally legal batch reaches dispatch under the write lock");
assert.equal(canRetryInForeground(legal.value.prepared[1], "unknown", false), false, "unknown delivery must not be replayed");
assert.equal(outcomeAfterCheck("unknown", "preexisting"), "unknown", "preexisting evidence must not turn an unknown action into success");

const concurrentScheduler = new ResourceScheduler();
const concurrentKey = "window:concurrent-transaction";
let releaseFirst;
let announceFirst;
const firstEntered = new Promise((resolve) => { announceFirst = resolve; });
const firstMayFinish = new Promise((resolve) => { releaseFirst = resolve; });
let concurrentDispatches = 0;
const validAction = [{ action: "click", x: 10, y: 10 }];
const first = runPreflightWrite(
	concurrentScheduler,
	concurrentKey,
	0,
	() => { preflightActionSequence(validAction, false, env); },
	async (nextEpoch) => {
		concurrentDispatches += 1;
		announceFirst();
		await firstMayFinish;
		return nextEpoch;
	},
);
await firstEntered;
let stalePreflightRan = false;
const stale = runPreflightWrite(
	concurrentScheduler,
	concurrentKey,
	0,
	() => {
		stalePreflightRan = true;
		preflightActionSequence(validAction, false, env);
	},
	async () => {
		concurrentDispatches += 1;
		return "must not dispatch";
	},
);
assert.equal(stalePreflightRan, true, "a concurrently prepared old state is still checked by the scheduler afterward");
releaseFirst();
await first;
await assert.rejects(stale, StaleResourceStateError);
assert.equal(concurrentScheduler.epoch(concurrentKey), 1);
assert.equal(concurrentDispatches, 1, "the real serialized epoch check rejects the queued stale transaction before native dispatch");

const runtimeFailureKey = "window:runtime-prepare-action-failure";
const runtimeFailureScheduler = new ResourceScheduler();
const dynamicBatch = [{ action: "click", x: 10, y: 10 }, { action: "keypress", keys: ["TAB"] }];
let dynamicNativeDispatches = 0;
await assert.rejects(
	runPreflightWrite(
		runtimeFailureScheduler,
		runtimeFailureKey,
		0,
		() => { preflightActionSequence(dynamicBatch, false, env); },
		async () => {
			const state = { currentFocus: false };
			const dispatchEnv = { ...env, image: undefined };
			for (const action of dynamicBatch) {
				const step = prepareAction(action, state, dispatchEnv);
				dynamicNativeDispatches += 1;
				if (!dispatchEnv.headless && (step.establishesFocus || (step.action === "click" && "x" in step.target))) {
					state.currentFocus = true;
				}
			}
		},
	),
		/image-bearing state/,
);
assert.equal(runtimeFailureScheduler.epoch(runtimeFailureKey), 1, "a dispatch-time prepareAction failure conservatively invalidates the old state");
assert.equal(dynamicNativeDispatches, 1, "dispatch-time validation may fail after an earlier action, so this test does not claim rollback");

console.log("action preflight and real scheduler transaction tests passed");
