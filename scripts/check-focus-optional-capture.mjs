import assert from "node:assert/strict";
import extension from "../extensions/computer-use.ts";
const registered=[];
extension({registerTool:t=>registered.push(t),registerCommand(){},on(){}});
const keypressSchema=registered.find(t=>t.name==="act_ui").parameters.properties.actions.items.anyOf.find(s=>s.properties.action.const==="keypress");
assert(keypressSchema.required.includes("ref"),"published standalone keypress contract requires explicit ref");
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeAct, executeFind, executeObserve, executeFocusWindow } from "../src/bridge.ts";
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
let actMode = "worked";
let focused = true;
let captureMode = "normal";
let delayedLook;
let releaseLate;
let focusMode = "normal";

process.env.PI_CODING_AGENT_DIR = path.join(temp, "agent-state");
process.env.PI_COMPUTER_USE_HEADLESS = "false";
process.env.PI_COMPUTER_USE_BROWSER_USE = "false";
delete process.env.PI_COMPUTER_USE_CDP_PORT;

Object.assign(currentPlatformBackend, {
  async ensureReady(_ctx, state) { return state; },
  async listApps() { return [{ appName: "FakeApp", bundleId: "com.example.fake", pid: 4242 }]; },
  async listRoots() { rootCalls += 1; return [{ ...root }]; },
  async focusWindow() { if (focusMode === "unknown") throw new HelperTransportError("focus reply lost", { command: "focusWindow", requestId: "focus-lost", requestWriteAttempted: true, reason: "timeout" }); return { activated: focused, raised: focused, focused }; },
  async getFrontmost() { if (!focused) return { pid: 99, windowId: 202 }; return { appName: "FakeApp", bundleId: "com.example.fake", pid: 4242, windowId: 101 }; },
  isBrowserApp() { return false; },
  isChromeFamilyApp() { return false; },
  async observe(_target, options) {
    captureCalls += 1;
    if (captureMode === "image_only_failed" && _target.includeImage) throw new Error("Capture timed out");
    if (captureMode === "failed") throw new Error("Capture timed out");
    if (captureMode === "transport") throw new HelperTransportError("capture-only reply lost", { command: "look", requestId: "look-lost", requestWriteAttempted: true, reason: "timeout" });
    const result = parseLookResponse({
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
    if (captureMode === "late") { delayedLook = result; return await new Promise(resolve => { releaseLate = () => resolve(result); }); }
    return result;
  },
  async act(request) {
    actCalls.push(request);
    if (actMode === "effect_unverified") return { outcome: "unknown", performed: { delivery: "ax" } };
    if (actMode === "worked") return { outcome: focused ? "worked" : "didnt", performed: { delivery: "ax" }, evidence: { focused }, error: focused ? undefined : { code: "foreground_mismatch", message: "not focused" } };
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
 const found = await executeFind("find", {}, undefined, undefined, ctx);
 const ref = found.details.windows[0].windowRef;
 const focus = (params={}) => executeFocusWindow("focus", {root:ref,...params}, undefined, undefined, ctx);
 let result = await focus();
 assert.equal(captureCalls,0,"default focus must not call capture backend");
 assert.equal(result.details.focusWindow.verified,true);
 assert.equal(result.details.observation.status,"omitted");
 assert.equal(result.details.capture,undefined);
 captureMode="failed";
 result=await focus({capture:true});
 assert.equal(result.details.focusWindow.verified,true);
 assert.equal(result.details.observation.status,"failed");
 assert.equal(result.details.execution.evidence.nativeFocus.focused,true);
 assert.equal(result.details.capture,undefined);
 assert(!result.content.some(c=>c.type==="image"));
 captureMode="transport";
 result=await focus({capture:true});
 assert.equal(result.details.focusWindow.verified,true);
 assert.equal(result.details.observation.status,"failed");
 assert.equal(result.details.status,undefined,"capture-only transport must not claim unknown input");
 assert.equal(result.details.execution.transport,undefined);
 // A fresh semantic look remains an eligible base after capture-only failure.
 captureMode="normal";
 let seen=await executeObserve("semantic",{root:ref,mode:"semantic",readText:"never"},undefined,undefined,ctx);
 const textRef=seen.details.outline.root.children.find(n=>n.role==="AXTextField").ref;
 result=await executeAct("eligible",{stateId:seen.details.capture.stateId,actions:[{action:"setText",ref:textRef,text:"one eligible action"}]},undefined,undefined,ctx);
 assert.equal(actCalls.length,1,"subsequent eligible action reaches backend");
 const beforeFailedFocus=result.details.capture.stateId;
 focused=false;captureMode="failed";
 result=await focus({capture:true});
 assert.equal(result.details.focusWindow.verified,false);
 assert.equal(result.details.execution.outcome,"didnt");
 const beforeRejectedAct=actCalls.length;
 await assert.rejects(()=>executeAct("reject-stale-after-failed-focus",{stateId:beforeFailedFocus,actions:[{action:"setText",ref:textRef,text:"must not dispatch"}]},undefined,undefined,ctx),/stale/i);
 assert.equal(actCalls.length,beforeRejectedAct,"failed focus must not authorize stale grounded input");
 assert.equal(result.details.observation.status,"failed");
 focused=true;captureMode="late";
 result=await focus({capture:true});
 assert.equal(result.details.observation.completion,"unconfirmed");
 assert.equal(result.details.observation.cancellationRequested,true);
 assert.equal(result.details.capture,undefined);
 captureMode="normal";
 seen=await executeObserve("after-timeout",{root:ref,mode:"semantic",readText:"never"},undefined,undefined,ctx);
 const validState=seen.details.capture.stateId;
 releaseLate();await new Promise(r=>setTimeout(r,20));
 // Late result cannot publish an observation or invalidate the fresh current state.
 const node=seen.details.outline.root.children.find(n=>n.role==="AXTextField").ref;
 await executeAct("after-late",{stateId:validState,actions:[{action:"setText",ref:node,text:"fresh survives"}]},undefined,undefined,ctx);
 assert.equal(actCalls.length,2);
 // Actual observe retains semantic state when image capture fails.
 captureMode="image_only_failed";
 seen=await executeObserve("optional-image",{root:ref,mode:"fused"},undefined,undefined,ctx);
 assert.equal(seen.details.observation.status,"semantic_only");
 assert.equal(seen.details.observation.nativeCompletion,"unconfirmed");
 assert(!seen.content.some(c=>c.type==="image"));
 assert.equal(seen.details.capture.width,0);
 captureMode="normal";actMode="effect_unverified";
 const saveRef=seen.details.outline.root.children.find(n=>n.role==="AXButton").ref;
 result=await executeAct("normal-return-save",{stateId:seen.details.capture.stateId,actions:[{action:"press",ref:saveRef}]},undefined,undefined,ctx);
 assert.equal(result.details.execution.outcome,"unknown");
 assert.equal(result.details.execution.dispatchCompletion,"returned");
 assert.equal(result.details.execution.effectVerification,"unverified");
 assert.equal(result.details.execution.transport,undefined);
 assert.equal(result.details.execution.inputDispatch,undefined);
 focusMode="unknown";
 await assert.rejects(()=>focus(),/focus reply lost|unknown/);
 console.log("actual focus executor: default/optional failure/eligible action/failed verification/late result/unknown focus passed");
} finally { Object.assign(currentPlatformBackend, original); rmSync(temp,{recursive:true,force:true}); }
