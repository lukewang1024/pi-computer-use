import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-cu-helper-transport-"));
const socketPath = path.join(tempRoot, "daemon.sock");
process.env.PI_CU_SOCKET_PATH = socketPath;

const requests = [];
const waiters = [];
const server = net.createServer((socket) => {
	socket.setEncoding("utf8");
	socket.on("error", () => undefined);
	let buffer = "";
	socket.on("data", (chunk) => {
		buffer += chunk;
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) break;
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			const request = JSON.parse(line);
			requests.push(request);
			for (const waiter of waiters.splice(0)) waiter();
			if (request.cmd === "diagnostics") {
				socket.end(`${JSON.stringify({ id: request.id, ok: true, result: {} })}\n`);
			} else {
				setTimeout(() => socket.end(`${JSON.stringify({ id: request.id, ok: true, result: { outcome: "worked" } })}\n`), 120);
			}
		}
	});
});

await new Promise((resolve, reject) => {
	server.once("error", reject);
	server.listen(socketPath, resolve);
});

class TrackedSignal extends EventTarget {
	aborted = false;
	listeners = new Set();

	addEventListener(type, listener, options) {
		if (type === "abort") this.listeners.add(listener);
		return super.addEventListener(type, listener, options);
	}

	removeEventListener(type, listener, options) {
		if (type === "abort") this.listeners.delete(listener);
		return super.removeEventListener(type, listener, options);
	}

	abort() {
		this.aborted = true;
		this.dispatchEvent(new Event("abort"));
	}
}

async function waitForActCount(count) {
	while (requests.filter((request) => request.cmd === "act").length < count) {
		await new Promise((resolve) => waiters.push(resolve));
	}
}

try {
	const { HelperTransportError, MacosHelperClient } = await import(`../src/platform/macos/helper.ts?test=${Date.now()}`);
	const client = new MacosHelperClient();
	const timeoutSignal = new TrackedSignal();
	let timeoutError;
	const timedOut = client.command("act", { action: "keypress" }, { timeoutMs: 30, signal: timeoutSignal });
	await waitForActCount(1);
	try {
		await timedOut;
	} catch (error) {
		timeoutError = error;
	}
	assert(timeoutError instanceof HelperTransportError, "timeout must remain a structured helper transport error");
	assert.equal(timeoutError.outcome, "unknown", "timeout must not claim the action was cancelled or not sent");
	assert.equal(timeoutError.requestWriteAttempted, true, "timeout metadata must distinguish a request written to the socket");
	assert.equal(timeoutError.requestId, requests.find((request) => request.cmd === "act")?.id, "timeout must preserve the native request id");
	assert.equal(timeoutError.reason, "timeout");
	assert.equal(timeoutSignal.listeners.size, 0, "timeout must remove the AbortSignal listener");

	const abortSignal = new TrackedSignal();
	let abortError;
	const aborted = client.command("act", { action: "keypress" }, { timeoutMs: 1_000, signal: abortSignal });
	await waitForActCount(2);
	abortSignal.abort();
	try {
		await aborted;
	} catch (error) {
		abortError = error;
	}
	assert(abortError instanceof HelperTransportError, "abort after request write must remain a structured transport error");
	assert.equal(abortError.outcome, "unknown", "socket closure must not be reported as native cancellation");
	assert.equal(abortError.requestWriteAttempted, true);
	assert.equal(abortError.requestId, requests.filter((request) => request.cmd === "act")[1]?.id);
	assert.equal(abortError.reason, "aborted");
	assert.equal(abortSignal.listeners.size, 0, "abort must remove the AbortSignal listener");

	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.equal(requests.filter((request) => request.cmd === "act").length, 2, "late replies must not trigger retries or duplicate dispatches");

	const bridge = await readFile(new URL("../src/bridge.ts", import.meta.url), "utf8");
	assert(bridge.includes('if (step.outcome !== "worked") break;'), "a batch must stop after any non-worked native action");
	const unknownGuard = bridge.indexOf('if (execution.transport?.outcome === "unknown" || execution.inputDispatch?.outcome === "unknown")');
	const postDispatchWork = bridge.indexOf("const executedActions = actions.slice", unknownGuard);
	assert(unknownGuard >= 0 && postDispatchWork > unknownGuard, "transport and partial-HID unknown must be recognized before normal post-action work");
	const terminalStart = bridge.indexOf("async function terminalDesktopActionResult(");
	const probeGuard = bridge.indexOf("if (!dispatchUnknown)", terminalStart);
	const rootProbe = bridge.indexOf("currentPlatformBackend.listRoots", terminalStart);
	assert(probeGuard > terminalStart && rootProbe > probeGuard, "unknown dispatch must not launch a follow-up helper probe");
	assert(bridge.includes('kind: "partial_hid"') && bridge.includes('code !== "foreground_interrupted_after_partial_hid"'), "partial HID results must keep their structured non-transport identity");
	assert(bridge.includes("Keep writes quarantined and perform explicit desktop recovery"), "the terminal result must preserve the executor quarantine instruction");
	console.log("helper transport timeout/abort checks passed");
} finally {
	await new Promise((resolve) => server.close(resolve));
	await rm(tempRoot, { recursive: true, force: true });
}
