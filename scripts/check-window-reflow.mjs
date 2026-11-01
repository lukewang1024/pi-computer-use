import assert from "node:assert/strict";
import { classifyWindowReflow } from "../src/window-reflow.ts";

const step = () => ({ outcome: "unknown", performed: { drag: { leftDownAfter: false } } });
const result = () => ({ operation: "window_reflow", dispatchCompletion: "returned", receipt: {
  outcome: "geometry_restored", mutationAttempts: 2, uiaRecoveryVerified: false, originalInputRetryProhibited: true,
}, steps: [step(), step()] });
assert.equal(classifyWindowReflow(result()), "returned");
const rejected = result();
rejected.dispatchCompletion = "not_sent";
rejected.receipt.outcome = "rejected_before_mutation";
rejected.receipt.mutationAttempts = 0;
rejected.steps = [];
assert.equal(classifyWindowReflow(rejected), "not_sent");
for (const modify of [
  r => { r.steps[0].error = { message: "partial" }; },
  r => { r.steps[1].performed.drag.leftDownAfter = true; },
  r => { r.steps[0].inputDispatch = { recoveryRequired: true }; },
  r => { r.receipt.originalInputRetryProhibited = false; },
  r => { r.receipt.uiaRecoveryVerified = true; },
  r => { r.receipt.mutationAttempts = 1; },
  r => { r.steps.pop(); },
  r => { r.dispatchCompletion = "partial_or_unknown"; },
]) {
  const candidate = result(); modify(candidate);
  assert.equal(classifyWindowReflow(candidate), "partial_or_unknown");
}
assert.equal(classifyWindowReflow(null), "partial_or_unknown");
console.log("Window reflow receipts fail closed on partial or contradictory evidence.");
