import assert from "node:assert/strict";
import { WindowsActionDiagnostics, sanitizeActionStages } from "../src/platform/windows/action-diagnostics.ts";
const frame = (id = "request-1", elapsedMs = 42) => JSON.stringify({
 event: "cu_action_phase", requestId: id, stage: "native_mutation_started", elapsedMs,
 secret: "must never escape diagnostics",
}) + "\n";
const parser = new WindowsActionDiagnostics(), rows = [];
const receive = (id, stage) => rows.push({ id, ...stage });
for (const byte of frame()) parser.push(byte, receive);
assert.deepEqual(rows, [{ id: "request-1", stage: "native_mutation_started", elapsedMs: 42 }]);
parser.push("x".repeat(4096), receive);
parser.push(frame(), receive); // Entire oversized line, including this frame, is discarded.
assert.equal(rows.length, 1);
parser.push(frame("request-2", 43), receive);
assert.equal(rows.length, 2);
for (const value of ["bad json\n", frame("invalid id"), frame("request-3", -1), frame("request-3", 1.5),
 frame("request-3", 86_400_001), '{"event":"other","requestId":"request-3","stage":"request_started","elapsedMs":1}\n',
 '{"event":"cu_action_phase","requestId":"request-3","stage":"sensitive text","elapsedMs":1}\n']) parser.push(value, receive);
assert.equal(rows.length, 2);
assert.equal(sanitizeActionStages(Array.from({length: 100}, () => ({stage:"request_started",elapsedMs:0}))).length, 32);
assert.deepEqual(sanitizeActionStages(null), []);
console.log("PASS bounded Windows diagnostic framing, malformed/oversized rejection and argument redaction; no input");
