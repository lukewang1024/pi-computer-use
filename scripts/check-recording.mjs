import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { recordingInput } from "../src/recording-input.ts";
import { ScreenRecorder } from "../src/recording.ts";
import computerUseExtension from "../extensions/computer-use.ts";
import { executeRecordingStatus, executeStopRecording } from "../src/bridge.ts";

const directory = await mkdtemp(path.join(os.tmpdir(), "pi-cu-recording-"));
const worker = `
const fs = require('node:fs');
const [mode, output] = process.argv.slice(1);
if (mode === 'fail') { process.stderr.write('no interactive desktop'); process.exit(1); }
if (mode === 'hang') { setInterval(() => {}, 1000); process.stdin.resume(); }
else {
 let frames = 0;
 fs.writeFileSync(output, 'video-test-data');
 const timer = setInterval(() => { frames++; process.stdout.write('frame='+frames+'\\nout_time_us='+frames*33333+'\\nprogress=continue\\n'); }, 20);
 const finish = () => { clearInterval(timer); process.stdout.write('progress=end\\n'); process.exit(0); };
 process.stdin.on('data', data => { if (mode !== 'stop-hang' && data.includes(113)) finish(); });
 if (mode === 'auto') setTimeout(finish, 100);
}
`;
const spawned = [];
function recorder(mode = "normal") {
	return new ScreenRecorder({
		platform: "win32", directory, startupTimeoutMs: 500, stopTimeoutMs: 100,
		spawn: (command, args, options) => {
			assert.equal(options.shell, false);
			assert.equal(options.windowsHide, true);
			assert.deepEqual(args.slice(args.indexOf("-f"), args.indexOf("-f") + 2), ["-f", "gdigrab"]);
			assert.equal(args[args.indexOf("-i") + 1], "desktop");
			assert.equal(args[args.indexOf("-draw_mouse") + 1], "1");
			const child = spawn(process.execPath, ["-e", worker, mode, args.at(-1)], options);
			spawned.push(child);
			return child;
		},
	});
}
const managers = [];
try {
	const tools = [];
	computerUseExtension({ registerTool: tool => tools.push(tool), registerCommand() {}, on() {} });
	for (const name of ["start_recording", "recording_status", "stop_recording"]) assert(tools.some(tool => tool.name === name));
	await assert.rejects(executeRecordingStatus("test", { recordingId: "unknown" }), /Unknown recordingId/);
	await assert.rejects(executeStopRecording("test", { recordingId: "unknown" }), /Unknown recordingId/);
	const r = recorder(); managers.push(r);
	await assert.rejects(r.start({ fps: 0 }), /fps/);
	await assert.rejects(r.start({ maxDurationSeconds: 601 }), /maxDurationSeconds/);
	const pending = r.start();
	await assert.rejects(r.start(), /already active/);
	const started = await pending;
	assert.equal(started.state, "recording");
	assert(started.frames > 0, "start must wait for a captured frame");
	assert.equal(started.fps, 30);
	await assert.rejects(r.stop("other-session"), /Unknown recordingId/);
	const stopped = await r.stop(started.recordingId);
	assert.equal(stopped.state, "completed");
	assert(stopped.bytes > 0);
	assert.deepEqual(await r.stop(started.recordingId), stopped, "stop must be idempotent");
	const auto = recorder("auto"); managers.push(auto);
	const a = await auto.start({ maxDurationSeconds: 1 });
	await new Promise(resolve => setTimeout(resolve, 150));
	assert.equal(auto.status(a.recordingId).state, "completed");
	const failed = recorder("fail"); managers.push(failed);
	await assert.rejects(failed.start(), /no interactive desktop/);
	const hung = recorder("hang"); managers.push(hung);
	await assert.rejects(hung.start(), /startup timeout/);
	assert(spawned.at(-1).signalCode, "startup timeout must terminate the encoder");
	const stopHung = recorder("stop-hang"); managers.push(stopHung);
	const sh = await stopHung.start();
	const stopFailed = await stopHung.stop(sh.recordingId);
	assert.equal(stopFailed.state, "failed");
	assert.match(stopFailed.error, /stop timeout/);
	assert(spawned.at(-1).signalCode, "stop timeout must terminate the encoder");
	const missing = new ScreenRecorder({ platform: "win32", directory, ffmpeg: path.join(directory, "missing-ffmpeg") }); managers.push(missing);
	await assert.rejects(missing.start(), /Install it on PATH/);
	const cancelled = recorder(); managers.push(cancelled);
	const abort = new AbortController();
	const c = cancelled.start({}, abort.signal);
	abort.abort();
	await assert.rejects(c);
	const cancelledChild = recorder("hang"); managers.push(cancelledChild);
	const childAbort = new AbortController();
	const childStart = cancelledChild.start({}, childAbort.signal);
	setTimeout(() => childAbort.abort(), 50);
	await assert.rejects(childStart, /cancelled/);
	const closed = recorder(); managers.push(closed);
	const running = await closed.start();
	await closed.shutdown();
	assert.equal(closed.status(running.recordingId).state, "completed");
	const race = recorder(); managers.push(race);
	const raceStart = race.start();
	const raceShutdown = race.shutdown();
	await assert.rejects(raceStart, /shutting down/);
	await raceShutdown;
	await assert.rejects(new ScreenRecorder({ platform: "freebsd" }).start(), /unsupported/);
	const macInput = await recordingInput("darwin", 30, {});
	assert.equal(macInput[macInput.indexOf("-i") + 1], "Capture screen 0:none", "must never select camera index zero");
	assert.equal(macInput[macInput.indexOf("-capture_cursor") + 1], "1");
	const secondScreen = await recordingInput("darwin", 60, { PI_COMPUTER_USE_RECORDING_SCREEN: "2" });
	assert.equal(secondScreen.at(-1), "Capture screen 2:none");
	await assert.rejects(recordingInput("darwin", 30, { PI_COMPUTER_USE_RECORDING_SCREEN: "default" }), /screen number/);
	await assert.rejects(recordingInput("linux", 30, {}), /DISPLAY/);
	await assert.rejects(recordingInput("linux", 30, { DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" }), /Wayland/);
	await assert.rejects(recordingInput("linux", 30, { DISPLAY: ":0", PI_COMPUTER_USE_RECORDING_SIZE: "0x0" }), /WIDTHxHEIGHT/);
	const x11Input = await recordingInput("linux", 30, { DISPLAY: ":12.0", PI_COMPUTER_USE_RECORDING_SIZE: "1680x1050" });
	assert.equal(x11Input[x11Input.indexOf("-video_size") + 1], "1680x1050");
	assert.equal(x11Input.at(-1), ":12.0");
	// Backends share real encoder lifecycle, not just argument construction.
	for (const platform of ["darwin", "linux"]) {
	 const multi = new ScreenRecorder({ platform, directory, env: { DISPLAY: ":12", PI_COMPUTER_USE_RECORDING_SIZE: "1680x1050" },
	  spawn: (_cmd, args, options) => { const child = spawn(process.execPath, ["-e", worker, "normal", args.at(-1)], options); spawned.push(child); return child; } });
	 managers.push(multi); const capture = await multi.start();
	 assert.equal((await multi.stop(capture.recordingId)).state, "completed");
	}
	console.log("PASS recording lifecycle, first-frame readiness, concurrent start, automatic completion, cancellation, failure, timeout and shutdown");
} finally {
	for (const manager of managers) await manager.shutdown();
	for (const child of spawned) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	await rm(directory, { recursive: true, force: true });
}
