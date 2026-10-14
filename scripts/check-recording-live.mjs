import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { ScreenRecorder } from "../src/recording.ts";

if (process.env.PI_CU_LIVE !== "1") {
	throw new Error("Native recording acceptance requires PI_CU_LIVE=1 on an interactive supported desktop.");
}
const children = [];
const recorder = new ScreenRecorder({ spawn: (command, args, options) => {
 const child = spawn(command, args, options); children.push(child); return child;
} });
const decode = async receipt => {
 await promisify(execFile)(process.env.PI_COMPUTER_USE_FFMPEG || "ffmpeg",
  ["-v", "error", "-i", receipt.path, "-f", "null", "-"], { timeout: 30_000, maxBuffer: 1024 * 1024 });
};
try {
	const started = await recorder.start({ fps: 30, maxDurationSeconds: 3 });
	assert(started.frames > 0, "start returned without an encoded frame");
	const deadline = Date.now() + 15_000;
	let receipt;
	do {
		await new Promise(resolve => setTimeout(resolve, 100));
		receipt = recorder.status(started.recordingId);
	} while (!["completed", "failed"].includes(receipt.state) && Date.now() < deadline);
	assert.equal(receipt.state, "completed", receipt.error || "recording did not automatically finalize");
	assert(receipt.bytes > 0);
	assert(receipt.frames >= 75, "three-second recording captured fewer than 75 frames");
	assert(receipt.durationSeconds >= 2.8);
	await decode(receipt);
	console.log(JSON.stringify({ mode: "automatic", ...receipt }, null, 2));
	for (const mode of ["early-stop", "session-shutdown"]) {
	 const next = await recorder.start({ fps: 30, maxDurationSeconds: 60 });
	 await new Promise(resolve => setTimeout(resolve, 500));
	 if (mode === "session-shutdown") await recorder.shutdown();
	 else await recorder.stop(next.recordingId);
	 const stopped = recorder.status(next.recordingId);
	 assert.equal(stopped.state, "completed", stopped.error);
	 assert(stopped.frames > 0 && stopped.durationSeconds < 60);
	 await decode(stopped);
	 console.log(JSON.stringify({ mode, ...stopped }, null, 2));
	}
	for (const child of children) assert(child.exitCode !== null || child.signalCode !== null, "recording encoder is still running");
} finally {
	await recorder.shutdown();
}
