import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeAct, executeFind, executeObserve } from "../src/bridge.ts";
import { currentPlatformBackend } from "../src/platform/index.ts";
import { HelperTransportError } from "../src/platform/macos/helper.ts";
import { parseLookResponse } from "../src/outline.ts";

const temp = mkdtempSync(path.join(os.tmpdir(), "cu-bridge-unknown-"));
const original = { ...currentPlatformBackend };
const framePoints = { x: 0, y: 0, w: 800, h: 600 };
const root = {
  kind: "window",
  rootRef: "native-root-1",
  windowRef: "native-window-1",
  windowId: 101,
  pid: 4242,
  appName: "FakeApp",
  bundleId: "com.example.fake",
  title: "Fake Document",
  role: "AXWindow",
  subrole: "AXStandardWindow",
  zOrder: 1,
  framePoints,
  scaleFactor: 1,
  isOnscreen: true,
  isFocused: true,
  isMinimized: false,
  isMain: true,
  isModal: false,
};
let captureCalls = 0;
let rootCalls = 0;
const actCalls = [];
let actMode = "transport";

process.env.PI_CODING_AGENT_DIR = path.join(temp, "agent-state");
process.env.PI_COMPUTER_USE_HEADLESS = "false";
process.env.PI_COMPUTER_USE_BROWSER_USE = "false";
delete process.env.PI_COMPUTER_USE_CDP_PORT;

Object.assign(currentPlatformBackend, {
  async ensureReady(_ctx, state) { return state; },
  async listApps() { return [{ appName: "FakeApp", bundleId: "com.example.fake", pid: 4242 }]; },
  async listRoots() { rootCalls += 1; return [{ ...root }]; },
  async getFrontmost() { return { appName: "FakeApp", bundleId: "com.example.fake", pid: 4242, windowId: 101 }; },
  isBrowserApp() { return false; },
  isChromeFamilyApp() { return false; },
  async observe() {
    captureCalls += 1;
    return parseLookResponse({
      lookId: "fake-look-" + captureCalls,
      capturedAt: Date.now() / 1000,
      window: {
        windowId: 101,
        framePoints,
        scaleFactor: 1,
        isModal: false,
        role: "AXWindow",
        subrole: "AXStandardWindow",
      },
      outline: {
        ref: "native-root-1",
        role: "AXWindow",
        children: [
          { ref: "native-text", role: "AXTextField", title: "Text", value: "before", canSetValue: true, isTextInput: true, actions: ["setValue"] },
          { ref: "native-button", role: "AXButton", title: "Continue", canPress: true, actions: ["press"] },
        ],
      },
      timings: {},
    });
  },
  async act(request) {
    actCalls.push(request);
    if (actMode === "partial_hid") {
      return {
        outcome: "unknown",
        performed: { delivery: "hid" },
        evidence: { foregroundVerification: { target: { pid: 4242, windowId: 101 }, actualForeground: { pid: 4242, windowId: 202 } } },
        error: { code: "foreground_interrupted_after_partial_hid", message: "focus changed after partial HID dispatch" },
        inputDispatch: { eventsDispatched: 3, unreleasedKeys: [1], unreleasedMouseButtons: [], recoveryRequired: true, retrySafe: false },
      };
    }
    throw new HelperTransportError("fake helper reply timeout after write", {
      command: "act",
      requestId: "bridge-fake-request-17",
      requestWriteAttempted: true,
      reason: "timeout",
    });
  },
});

try {
  const ctx = { cwd: temp };
  const found = await executeFind("find-fake", {}, undefined, undefined, ctx);
  assert.equal(found.details.windows.length, 1, "fake root discovery did not return one root");
  const observed = await executeObserve("observe-fake", {
    root: found.details.windows[0].windowRef,
    mode: "semantic",
    readText: "never",
  }, undefined, undefined, ctx);
  const stateId = observed.details.capture.stateId;
  const nodes = observed.details.outline.root.children;
  const textRef = nodes.find((node) => node.role === "AXTextField")?.ref;
  const buttonRef = nodes.find((node) => node.role === "AXButton")?.ref;
  assert(textRef && buttonRef, "fake observation did not produce both action refs");

  const capturesBeforeAct = captureCalls;
  const rootsBeforeAct = rootCalls;
  const result = await executeAct("act-fake", {
    stateId,
    actions: [
      { action: "setText", ref: textRef, text: "unknown must stop this batch" },
      { action: "press", ref: buttonRef },
    ],
  }, undefined, undefined, ctx);

  assert.equal(result.details.status, "dispatch_outcome_unknown");
  assert.equal(result.details.execution.transport.outcome, "unknown");
  assert.equal(result.details.execution.transport.requestId, "bridge-fake-request-17");
  assert.equal(actCalls.length, 1, "the bridge dispatched a later action after the first unknown");
  assert.equal(captureCalls, capturesBeforeAct, "the bridge captured a successor state after unknown");
  assert.equal(rootCalls, rootsBeforeAct + 1, "current-target resolution may list roots once; terminal transport unknown adds no follow-up probe");

  actMode = "partial_hid";
  actCalls.length = 0;
  const secondFound = await executeFind("find-fake-partial", {}, undefined, undefined, ctx);
  const secondObserved = await executeObserve("observe-fake-partial", {
    root: secondFound.details.windows[0].windowRef,
    mode: "semantic",
    readText: "never",
  }, undefined, undefined, ctx);
  const secondStateId = secondObserved.details.capture.stateId;
  const secondNodes = secondObserved.details.outline.root.children;
  const secondTextRef = secondNodes.find((node) => node.role === "AXTextField")?.ref;
  const secondButtonRef = secondNodes.find((node) => node.role === "AXButton")?.ref;
  assert(secondTextRef && secondButtonRef, "second fake observation did not produce both action refs");

  const partialCapturesBeforeAct = captureCalls;
  const partialRootsBeforeAct = rootCalls;
  const partialResult = await executeAct("act-fake-partial", {
    stateId: secondStateId,
    actions: [
      { action: "setText", ref: secondTextRef, text: "partial dispatch must stop this batch" },
      { action: "press", ref: secondButtonRef },
    ],
  }, undefined, undefined, ctx);
  assert.equal(partialResult.details.status, "dispatch_outcome_unknown");
  assert.equal(partialResult.details.error.code, "foreground_interrupted_after_partial_hid");
  assert.equal(partialResult.details.execution.inputDispatch.kind, "partial_hid");
  assert.equal(partialResult.details.execution.inputDispatch.eventsDispatched, 3);
  assert.deepEqual(partialResult.details.execution.inputDispatch.unreleasedKeys, [1]);
  assert.equal(partialResult.details.execution.transport, undefined, "partial HID must not be mislabeled as transport failure");
  assert.equal(actCalls.length, 1, "the bridge dispatched a later action after partial HID became unknown");
  assert.equal(captureCalls, partialCapturesBeforeAct, "the bridge captured a successor state after partial HID became unknown");
  assert.equal(rootCalls, partialRootsBeforeAct + 1, "current-target resolution may list roots once; terminal partial-HID unknown adds no follow-up probe");
  assert.match(partialResult.content[0].text, /Do not retry this action/);
  assert.match(partialResult.content[0].text, /do not send blind global key-up or button-up/);
  console.log("PASS actual executeAct stops later actions and successor capture for transport and partial-HID unknown");
} finally {
  Object.assign(currentPlatformBackend, original);
  rmSync(temp, { recursive: true, force: true });
}
