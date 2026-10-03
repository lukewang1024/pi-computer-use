import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { waitForBrowserStartup } from "../src/browser-startup.ts";

const neverReady = (signal) => new Promise((_, reject) => {
 if (signal.aborted) return reject(new Error("aborted"));
 signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
});
// Real asynchronous spawn failure must become a rejection, not an unhandled error.
const missing = spawn(process.execPath + ".cu-missing-executable", [], { stdio: "ignore" });
await assert.rejects(waitForBrowserStartup(missing, neverReady), /failed to start.*ENOENT/);
assert.equal(missing.listenerCount("error"), 0);
const exits = spawn(process.execPath, ["-e", "process.exit(7)"], { stdio: "ignore" });
await assert.rejects(waitForBrowserStartup(exits, neverReady), /code=7/);
assert.equal(exits.listenerCount("exit"), 0);
let canceled = false;
const child = Object.assign(new EventEmitter(), { pid: 1 });
await waitForBrowserStartup(child, async signal => {
 signal.addEventListener("abort", () => { canceled = true; }, { once: true });
});
assert(canceled);
assert.equal(child.listenerCount("error"), 0);
const controller = new AbortController();
const aborted = waitForBrowserStartup(new EventEmitter(), neverReady, controller.signal);
controller.abort();
await assert.rejects(aborted, /aborted/);
console.log("Browser startup: missing executable, early exit, readiness, and cancellation passed.");

// Cancellation must not expose the later asynchronous ENOENT as an unhandled error.
const canceledMissing = spawn(process.execPath + ".cu-missing-executable", [], { stdio: "ignore" });
const canceledController = new AbortController();
const canceledLaunch = waitForBrowserStartup(canceledMissing, neverReady, canceledController.signal);
canceledController.abort();
await assert.rejects(canceledLaunch, /aborted|failed to start/);
await new Promise(resolve => setImmediate(resolve));
assert.equal(canceledMissing.listenerCount("error"), 0);
