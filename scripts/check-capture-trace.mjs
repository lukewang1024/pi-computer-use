import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
if(process.platform!=='darwin'){console.log('native capture trace test: macOS only');process.exit(0);}
const source=fs.readFileSync(new URL('../native/macos/bridge.swift',import.meta.url),'utf8');
const trace=source.slice(source.indexOf('final class CaptureTrace {'),source.indexOf('final class AXRefStore'));
const methods=source.slice(source.indexOf('\tprivate func captureSnapshots()'),source.indexOf('\n\tprivate func captureWindow(')).replaceAll('private func','func');
const manager=`struct BridgeFailure: Error { let message: String; let code: String; var details: [String: Any] = [:] }
final class TrackerFixture {
let captureTraceLock = NSLock()
var captureTraces: [CaptureTrace] = []
func pidForWindowId(_ id: UInt32) -> Int32? { 42 }
${methods}
}
`;
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cu-capture-trace-'));
try{
 fs.writeFileSync(path.join(dir,'main.swift'),'import Foundation\n'+trace+manager+`
let trace = CaptureTrace(requestId: "req-test", windowId: 7, pid: 42)
trace.mark("shareableStart")
trace.mark("deadline", ["cancellationRequested": true])
let pending = trace.snapshot()
precondition(pending["completed"] as? Bool == false)
precondition(pending["cancellationRequested"] as? Bool == true)
precondition(pending["requestId"] as? String == "req-test")
precondition(pending["pid"] as? Int == 42 && pending["windowId"] as? Int == 7)
trace.mark("shareableEnd")
trace.mark("taskCompletion", ["taskCompleted": true, "taskCancelledAtCompletion": true])
precondition(trace.snapshot()["completed"] as? Bool == false) // fallback/request not returned
trace.mark("requestReturn", ["requestCompleted": true])
precondition(trace.snapshot()["completed"] as? Bool == true)
precondition(pending["completed"] as? Bool == false) // immutable prior receipt
precondition(trace.snapshot()["imageEndMs"] == nil) // no invented completion
let tracker = TrackerFixture()
var active: [CaptureTrace] = []
for n in 0..<4 { active.append(try tracker.beginCapture(requestId: "r"+String(n), windowId: UInt32(n+1))) }
func refused() -> Bool { do { _ = try tracker.beginCapture(requestId: "busy", windowId: 8); return false } catch { return true } }
precondition(refused())
active[0].mark("cancel", ["cancellationRequested": true])
precondition(refused())
active[0].mark("taskCompletion", ["taskCompleted": true])
precondition(refused())
active[0].mark("requestReturn", ["requestCompleted": true])
let next = try tracker.beginCapture(requestId: "next", windowId: 9)
next.mark("taskCompletion", ["taskCompleted": true]);next.mark("requestReturn", ["requestCompleted": true])
for n in 0..<80 { let item = try tracker.beginCapture(requestId: "done"+String(n), windowId: 10); item.mark("done", ["taskCompleted": true, "requestCompleted": true]) }
precondition(tracker.captureSnapshots().count <= 33)
print("capture trace: request identity, cancellation vs task/request completion, late completion, bounded pending admission and history passed")
`);
 const result=spawnSync('swift',[path.join(dir,'main.swift')],{encoding:'utf8',timeout:60000});
 assert.equal(result.status,0,result.stderr);console.log(result.stdout.trim());
}finally{fs.rmSync(dir,{recursive:true,force:true});}
