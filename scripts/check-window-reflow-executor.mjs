import assert from "node:assert/strict";
import { parseLookResponse } from "../src/outline.ts";
import { currentPlatformBackend as backend } from "../src/platform/index.ts";
import { executeFind, executeObserve, executeReflowWindow, shutdownComputerUseSession } from "../src/bridge.ts";

const platform = Object.getOwnPropertyDescriptor(process, "platform");
Object.defineProperty(process, "platform", { value: "win32", configurable: true });
const root = { kind: "window", rootRef: "native-root", windowRef: "native-root", windowId: 10, pid: 7, appName: "Fixture", title: "Owned fixture", zOrder: 0, framePoints: { x: 0, y: 0, w: 100, h: 100 }, scaleFactor: 1, isOnscreen: true, isFocused: true, isMinimized: false, isMain: true, isModal: false };
const overrides = {
  ensureReady: async () => ({ lastPermissionCheckAt: Date.now() }),
  listApps: async () => [{ appName: "Fixture", pid: 7 }], listRoots: async () => [root],
  getFrontmost: async () => ({ appName: "Fixture", pid: 7, windowId: 10, rootRef: "native-root" }),
  observe: async () => parseLookResponse({ lookId: "fixture-look", capturedAt: Date.now() / 1000, window: { windowId: 10, framePoints: root.framePoints, scaleFactor: 1 }, outline: { ref: "native-root", role: "window", title: "Fixture", children: [] }, image: { jpegBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT1sAAAAASUVORK5CYII=", mimeType: "image/png", width: 1, height: 1 }, timings: {} }),
  reflowWindow: undefined,
};
const original = Object.fromEntries(Object.keys(overrides).map(key => [key, backend[key]]));
Object.assign(backend, overrides);
const call = (fn, params) => fn("reflow-regression", params, undefined, undefined, { cwd: process.cwd(), hasUI: false });
try {
  for (const transport of [false, true]) {
    await shutdownComputerUseSession();
    let calls = 0;
    backend.reflowWindow = async (lookId, pid) => {
      calls++;
      assert.equal(lookId, "fixture-look"); assert.equal(pid, 7);
      if (transport) throw Object.assign(new Error("reply lost"), { code: "helper_transport_unknown", outcome: "unknown", command: "reflowWindow", requestId: "reflow-request", requestWriteAttempted: true, stages: [{ stage: "reflow_expand_started", elapsedMs: 4 }] });
      return { operation: "window_reflow", dispatchCompletion: "partial_or_unknown", receipt: { outcome: "restore_uncertain", mutationAttempts: 2, originalInputRetryProhibited: true, uiaRecoveryVerified: false }, steps: [{}, { outcome: "unknown", inputDispatch: { unreleasedMouseButtons: [1], recoveryRequired: true } }] };
    };
    const roots = await call(executeFind, { text: "Owned fixture" });
    const observation = await call(executeObserve, { root: roots.details.windows[0].windowRef, mode: "visual" });
    const stateId = observation.details.capture.stateId;
    const result = await call(executeReflowWindow, { stateId });
    assert.equal(result.details.execution.dispatchCompletion, "unknown");
    assert.equal(result.details.execution.recoveryRequired, true);
    assert.equal(result.details.originalInputRetryProhibited, true);
    assert.equal(result.details.uiaRecoveryVerified, false);
    if (transport) assert.equal(result.details.execution.transport.requestId, "reflow-request");
    else { assert.deepEqual(result.details.nativeReceipt.steps[1].inputDispatch.unreleasedMouseButtons, [1]); assert.deepEqual(result.details.execution.inputDispatch.unreleasedMouseButtons, [1]); }
    await assert.rejects(() => call(executeReflowWindow, { stateId }), /stale/i);
    assert.equal(calls, 1, "uncertain recovery must never replay against its old state");
  }
  console.log("Public reflow executor preserves uncertain receipts and invalidates old state.");
} finally {
  Object.assign(backend, original);
  if (platform) Object.defineProperty(process, "platform", platform);
  await shutdownComputerUseSession();
}
