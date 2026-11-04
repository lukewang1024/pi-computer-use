import assert from "node:assert/strict";
import { associatedModal, actWithOwnedModal } from "../src/platform/windows/modal-action.ts";
import { ModalContinuation } from "../src/modal-continuation.ts";
import { parseLookResponse } from "../src/outline.ts";
import { currentPlatformBackend as backend } from "../src/platform/index.ts";
import { executeAct, executeFind, executeObserve, executeSearchUi, shutdownComputerUseSession } from "../src/bridge.ts";
import { NativeActionPreflightError } from "../src/action-preflight.ts";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const root = (windowId, title, enabled, ownerHwnd) => ({
	kind: ownerHwnd ? "popover" : "window", rootRef: `native-${windowId}`, windowRef: `native-${windowId}`,
	windowId, pid: 7, appName: "Fixture", title, zOrder: 0,
	framePoints: { x: 0, y: 0, w: 300, h: 200 }, scaleFactor: 1,
	isOnscreen: true, isFocused: Boolean(ownerHwnd), isMinimized: false, isMain: true, isModal: Boolean(ownerHwnd),
	metadata: { className: "fixture", interaction: { enabled, ownerHwnd: ownerHwnd ?? null, ownerDisabled: ownerHwnd ? true : null } },
});
const before = [root(10, "Caption", true)];
const after = [root(10, "Caption", false), root(20, "New Label", true, 10)];
assert.equal(associatedModal(before, after, 7, 10)?.windowId, 20);
assert.equal(associatedModal(before, [root(10, "Caption", true), after[1]], 7, 10), undefined, "the parent must actually become disabled");
assert.equal(associatedModal(before, [after[0], root(20, "Unrelated", true, 99)], 7, 10), undefined, "owner must match the exact parent");
assert.equal(associatedModal([...before, after[1]], after, 7, 10), undefined, "preexisting windows are not new evidence");
assert.equal(associatedModal(before, [...after, root(21, "Ambiguous", true, 10)], 7, 10), undefined, "multiple candidates are not uniquely attributable");
assert.equal(associatedModal([], after, 7, 10), undefined, "a missing baseline is not evidence");
assert.equal(associatedModal(before, [after[0], { ...after[1], title: "" }], 7, 10), undefined, "an untitled candidate has no stable identity");

// Word's caption dialog is itself owned by the disabled document window. Its
// New Label dialog uses the same window class; exact ownership must still pick
// only the newly opened child, not the already disabled document or parent.
const wordRoot = (windowId, title, enabled, ownerHwnd) => {
	const value = root(windowId, title, enabled, ownerHwnd);
	value.metadata.className = ownerHwnd ? "bosa_sdm_msword" : "OpusApp";
	return value;
};
const wordBefore = [wordRoot(100, "Document - Word", false), wordRoot(101, "Caption", true, 100)];
const wordAfter = [wordRoot(100, "Document - Word", false), wordRoot(101, "Caption", false, 100), wordRoot(102, "New Label", true, 101)];
assert.equal(associatedModal(wordBefore, wordAfter, 7, 101)?.windowId, 102, "nested Word dialog ownership identifies the new label window");

let displayed = false, releaseAction, dispatches = 0, returned = false;
const completion = new Promise((resolve) => { releaseAction = resolve; });
const action = actWithOwnedModal({
	pid: 7, parentWindowId: 10, timeoutMs: 1_500,
	listRoots: async () => displayed ? after : before,
	act: async ({ onRequestId, onStage }) => {
		dispatches++; onRequestId("request-1"); onStage({ stage: "native_mutation_started", elapsedMs: 1 }); displayed = true;
		const result = await completion; returned = true; return result;
	},
});
const pending = await action;
assert.equal(pending.kind, "modal_pending");
assert.equal(pending.pending.modal.windowId, 20);
assert.equal(returned, false, "opening the modal must not fabricate native completion");
assert.equal(dispatches, 1, "the native action must be sent exactly once");
releaseAction({ outcome: "worked" });
assert.equal((await pending.pending.completion).outcome, "worked");

let quickDispatches = 0;
const quick = await actWithOwnedModal({ pid: 7, parentWindowId: 10, timeoutMs: 500, listRoots: async () => before,
	act: async () => { quickDispatches++; return { outcome: "worked" }; } });
assert.equal(quick.kind, "completed");
assert.equal(quickDispatches, 1);
let baselineFailureDispatches = 0;
await assert.rejects(() => actWithOwnedModal({ pid: 7, parentWindowId: 10, timeoutMs: 500,
	listRoots: async () => { throw new Error("read timed out"); },
	act: async () => { baselineFailureDispatches++; return { outcome: "worked" }; },
}), /no input was sent/);
assert.equal(baselineFailureDispatches, 0, "a failed baseline read must not send input");

let returnedFirst = false;
const noEarlyResult = await actWithOwnedModal({ pid: 7, parentWindowId: 10, timeoutMs: 1_000,
	listRoots: async () => returnedFirst ? after : before,
	act: async ({ onRequestId, onStage }) => {
		onRequestId("request-returned"); onStage({ stage: "native_mutation_started", elapsedMs: 1 });
		onStage({ stage: "native_mutation_returned", elapsedMs: 2 }); returnedFirst = true;
		await sleep(200); return { outcome: "worked" };
	},
});
assert.equal(noEarlyResult.kind, "completed", "a returned native invocation must not be converted to a pending modal");

let observerReads = 0;
const observerFailure = await actWithOwnedModal({ pid: 7, parentWindowId: 10, timeoutMs: 1_000,
	listRoots: async () => ++observerReads === 1 ? before : [after[0], { ...after[1], title: 17 }],
	act: async ({ onRequestId, onStage }) => {
		onRequestId("observer-failure"); onStage({ stage: "native_mutation_started", elapsedMs: 1 });
		await sleep(200); return { outcome: "worked" };
	},
});
assert.equal(observerFailure.kind, "completed", "observer failure must not abandon a dispatched native action");

let timeoutDispatches = 0;
await assert.rejects(() => actWithOwnedModal({ pid: 7, parentWindowId: 10, timeoutMs: 200, listRoots: async () => before,
	act: async ({ signal, onRequestId, onStage }) => {
		timeoutDispatches++; onRequestId("timeout-1"); onStage({ stage: "native_mutation_started", elapsedMs: 1 });
		return await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { code: "helper_transport_unknown" })), { once: true }));
	},
}), /timed out after 200ms/);
assert.equal(timeoutDispatches, 1, "a genuine hang must not be replayed");

const fence = new ModalContinuation();
const leave = fence.enterWrite();
const leaveConcurrent = fence.enterWrite();
assert.equal(fence.beginMonitoring(), undefined, "existing concurrent writes disable modal detection");
leaveConcurrent();
const endMonitoring = fence.beginMonitoring();
assert(endMonitoring);
assert.throws(() => fence.enterWrite(), /no input was sent/, "another tool must not race modal detection");
endMonitoring(); leave();
let settle;
const held = new Promise((resolve) => { settle = resolve; });
fence.register(7, 10, after[1], "request-2", held);
assert.equal(fence.completion(), "pending");
const leaveModal = fence.enterWrite();
assert.throws(() => fence.enterWrite(), /no input was sent/, "continuation and unscoped writes must not race");
leaveModal();
await assert.rejects(() => fence.rejectUnscopedWrite(async () => after), /only the exact observed modal/);
await assert.rejects(() => fence.guardWrite(7, 10, async () => after), /restricted/);
await assert.rejects(() => fence.guardWrite(8, 20, async () => after), /restricted/);
await assert.rejects(() => fence.guardWrite(7, 20, async () => [after[0], { ...after[1], title: "Replacement" }]), /restricted/);
assert.equal(await fence.guardWrite(7, 20, async () => after), true);
fence.markUncertain(); settle({ outcome: "worked" }); await sleep(0);
await assert.rejects(() => fence.guardWrite(7, 20, async () => after), /recovery/, "late success must not erase a later uncertain input");
fence.clear();
const changingCompletionFence = new ModalContinuation();
let rejectOriginal;
const failingOriginal = new Promise((_resolve, reject) => { rejectOriginal = reject; });
changingCompletionFence.register(7, 10, after[1], "request-failing", failingOriginal);
await assert.rejects(() => changingCompletionFence.guardWrite(7, 20, async () => {
	rejectOriginal(new Error("transport lost")); await sleep(0); return after;
}), /changed during window validation/);
changingCompletionFence.clear();
const changingFence = new ModalContinuation();
changingFence.register(7, 10, after[1], "request-changing", Promise.resolve({ outcome: "worked" }));
await sleep(0);
let closureReads = 0;
await assert.rejects(() => changingFence.guardWrite(7, 10, async () => ++closureReads === 1 ? before : after), /closure could not be confirmed/);
changingFence.clear();
const lateWindowFence = new ModalContinuation();
lateWindowFence.register(7, 10, after[1], "request-late-window", Promise.resolve({ outcome: "worked" }));
await sleep(0);
let lateClosureReads = 0;
await assert.rejects(() => lateWindowFence.guardWrite(7, 10, async () => ++lateClosureReads <= 2 ? before : after), /closure changed/);
lateWindowFence.clear();
const completedFence = new ModalContinuation();
completedFence.register(7, 10, after[1], "request-completed", Promise.resolve({ outcome: "worked" }));
await sleep(0);
await completedFence.rejectUnscopedWrite(async () => before);
assert.equal(completedFence.hasPending(), false, "a completed action and confirmed closed modal must release unscoped writes");

// Public executor regression: a pending press yields a real modal state, and
// later input is accepted only against that exact window.
let modalOpen = false, modalValue = "", modalDispatches = 0, childDispatches = 0, finishOriginal;
const originalCompletion = new Promise((resolve) => { finishOriginal = resolve; });
const roots = () => modalOpen ? [root(10, "Caption", false), root(20, "New Label", true, 10)] : before;
const overrides = {
	name: "windows",
	ensureReady: async () => ({ lastPermissionCheckAt: Date.now() }),
	listApps: async () => [{ appName: "Fixture", pid: 7 }],
	listRoots: async () => roots(),
	getFrontmost: async () => ({ appName: "Fixture", pid: 7, windowId: modalOpen ? 20 : 10, rootRef: modalOpen ? "native-20" : "native-10" }),
	isBrowserApp: () => false,
	isChromeFamilyApp: () => false,
	observe: async (request) => {
		const modal = request.target.windowId === 20;
		return parseLookResponse({ lookId: modal ? "modal-look" : "parent-look", capturedAt: Date.now() / 1000,
			window: { windowId: modal ? 20 : 10, framePoints: { x: 0, y: 0, w: 300, h: 200 }, scaleFactor: 1, isModal: modal },
			outline: { ref: modal ? "modal-root" : "parent-root", role: "window", children: modal ? [
				{ ref: "label", role: "edit", title: "Label", value: modalValue, canSetValue: true, isTextInput: true },
				{ ref: "ok", role: "button", title: "OK", canPress: true, actions: ["press"] },
			] : [{ ref: "open", role: "button", title: "New Label", canPress: true, actions: ["press"] }] }, timings: {} });
	},
	actWithModal: async () => {
		modalDispatches++;
		if (modalDispatches > 1) return { kind: "completed", result: { outcome: "worked" } };
		modalOpen = true;
		return { kind: "modal_pending", pending: { requestId: "live-request", modal: roots()[1], completion: originalCompletion } };
	},
	act: async (request) => {
		childDispatches++;
		if (request.action === "setText") modalValue = request.params.text;
		if (request.action === "press") { modalOpen = false; finishOriginal({ outcome: "worked" }); }
		return { outcome: "worked", performed: { delivery: "ax" } };
	},
	actBatch: undefined,
};
const original = Object.fromEntries(Object.keys(overrides).map((key) => [key, backend[key]]));
Object.assign(backend, overrides);
const call = (fn, params) => fn("windows-modal-regression", params, undefined, undefined, { cwd: process.cwd(), hasUI: false });
try {
	const found = await call(executeFind, { text: "Caption" });
	const parentRef = found.details.windows[0].windowRef;
	const observed = await call(executeObserve, { root: parentRef, mode: "semantic" });
	const button = await call(executeSearchUi, { stateId: observed.details.capture.stateId, text: "New Label", role: "button" });
	const result = await call(executeAct, { stateId: observed.details.capture.stateId, observationMode: "semantic", actions: [{ action: "press", ref: button.details.matches[0].ref }] });
	assert.equal(result.details.status, "modal_pending");
	assert.equal(result.details.execution.dispatchCompletion, "pending");
	assert.equal(result.details.execution.outcome, "unknown", "a pending native call is not a terminal success");
	assert.equal(result.details.target.windowId, 20);
	assert(result.details.capture.stateId, "the modal must have a fresh actionable observation");

	const parentAgain = await call(executeObserve, { root: parentRef, mode: "semantic" });
	const parentButton = await call(executeSearchUi, { stateId: parentAgain.details.capture.stateId, text: "New Label", role: "button" });
	await assert.rejects(() => call(executeAct, { stateId: parentAgain.details.capture.stateId, actions: [{ action: "press", ref: parentButton.details.matches[0].ref }] }), /restricted/);
	assert.equal(modalDispatches, 1, "the original click must not be replayed");

	const modalRef = result.details.target.windowRef;
	const freshModal = await call(executeObserve, { root: modalRef, mode: "semantic" });
	const label = await call(executeSearchUi, { stateId: freshModal.details.capture.stateId, text: "Label", role: "edit" });
	const initialOk = await call(executeSearchUi, { stateId: freshModal.details.capture.stateId, text: "OK", role: "button" });
	await assert.rejects(() => call(executeAct, { stateId: freshModal.details.capture.stateId, actions: [
		{ action: "setText", ref: label.details.matches[0].ref, text: "表" },
		{ action: "press", ref: initialOk.details.matches[0].ref },
	] }), /only one modal action at a time/);
	assert.equal(childDispatches, 0, "a rejected modal batch must not send any input");
	const workingAct = backend.act;
	backend.act = async () => { throw new NativeActionPreflightError("ElementFromHandle: timeout", "uia_resolution_failed"); };
	await assert.rejects(() => call(executeAct, { stateId: freshModal.details.capture.stateId, actions: [{ action: "setText", ref: label.details.matches[0].ref, text: "表" }] }), error => {
		assert.equal(error.preflight?.inputDispatched, false);
		return true;
	});
	assert.equal(modalValue, "", "a proved resolution failure must not change the label");
	backend.act = workingAct;
	const refreshedModal = await call(executeObserve, { root: modalRef, mode: "semantic" });
	const refreshedLabel = await call(executeSearchUi, { stateId: refreshedModal.details.capture.stateId, text: "Label", role: "edit" });
	const typed = await call(executeAct, { stateId: refreshedModal.details.capture.stateId, observationMode: "semantic", actions: [{ action: "setText", ref: refreshedLabel.details.matches[0].ref, text: "表" }] });
	assert.equal(modalValue, "表");
	const ok = await call(executeSearchUi, { stateId: typed.details.capture.stateId, text: "OK", role: "button" });
	const closed = await call(executeAct, { stateId: typed.details.capture.stateId, actions: [{ action: "press", ref: ok.details.matches[0].ref }] });
	assert.equal(modalOpen, false);
	assert.equal(closed.details.execution.priorModalAction.completion, "returned", "the original action must be reconciled after the modal closes");
	assert.equal(childDispatches, 2);
	const parentAfter = await call(executeObserve, { root: parentRef, mode: "semantic" });
	const parentAfterButton = await call(executeSearchUi, { stateId: parentAfter.details.capture.stateId, text: "New Label", role: "button" });
	await call(executeAct, { stateId: parentAfter.details.capture.stateId, observationMode: "semantic", actions: [{ action: "press", ref: parentAfterButton.details.matches[0].ref }] });
	assert.equal(modalDispatches, 2, "a completed original action must release the fence for a new request");
	let finishUncertain;
	backend.actWithModal = async () => {
		modalOpen = true;
		return { kind: "modal_pending", pending: { requestId: "shutdown-request", modal: roots()[1], completion: new Promise(resolve => { finishUncertain = resolve; }) } };
	};
	const priorShutdown = await call(executeObserve, { root: parentRef, mode: "semantic" });
	const shutdownButton = await call(executeSearchUi, { stateId: priorShutdown.details.capture.stateId, text: "New Label", role: "button" });
	const unresolved = await call(executeAct, { stateId: priorShutdown.details.capture.stateId, observationMode: "semantic", actions: [{ action: "press", ref: shutdownButton.details.matches[0].ref }] });
	assert.equal(unresolved.details.status, "modal_pending");
	const uncertainModal = await call(executeObserve, { root: unresolved.details.target.windowRef, mode: "semantic" });
	const uncertainLabel = await call(executeSearchUi, { stateId: uncertainModal.details.capture.stateId, text: "Label", role: "edit" });
	let unknownAttempts = 0;
	backend.act = async () => { unknownAttempts++; throw Object.assign(new Error("ElementFromHandle: timeout"), { code: "internal_error" }); };
	await assert.rejects(() => call(executeAct, { stateId: uncertainModal.details.capture.stateId, actions: [{ action: "setText", ref: uncertainLabel.details.matches[0].ref, text: "表" }] }), /ElementFromHandle/);
	const observeAfterUnknown = await call(executeObserve, { root: unresolved.details.target.windowRef, mode: "semantic" });
	const labelAfterUnknown = await call(executeSearchUi, { stateId: observeAfterUnknown.details.capture.stateId, text: "Label", role: "edit" });
	await assert.rejects(() => call(executeAct, { stateId: observeAfterUnknown.details.capture.stateId, actions: [{ action: "setText", ref: labelAfterUnknown.details.matches[0].ref, text: "表" }] }), /recovery/);
	assert.equal(unknownAttempts, 1, "an ordinary error without preflight proof must remain fenced");
	finishUncertain({ outcome: "worked" });
	await sleep(0);
	let cleanupCompleted = false;
	const previousShutdown = backend.shutdown;
	try {
		backend.shutdown = async () => { await sleep(10); cleanupCompleted = true; };
		await shutdownComputerUseSession();
		assert.equal(cleanupCompleted, true, "shutdown must await resource cleanup even after unknown input");
		assert.equal(unresolved.details.execution.dispatchCompletion, "pending", "cleanup must not rewrite an input receipt as success");
		backend.shutdown = async () => { throw new Error("native process still alive"); };
		await assert.rejects(() => shutdownComputerUseSession(), /native process still alive/);
	} finally { backend.shutdown = previousShutdown; }
	console.log("Windows pending-modal detection and public executor regression checks passed.");
} finally {
	Object.assign(backend, original);
	await shutdownComputerUseSession();
}
