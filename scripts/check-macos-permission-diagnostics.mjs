import assert from 'node:assert/strict';
import { macosHelper } from '../src/platform/macos/helper.ts';
const original = macosHelper.command;
let calls = 0, raw;
macosHelper.command = async (action) => {
  assert.equal(action, 'diagnostics', 'diagnostics must not probe capture or request permissions');
  calls++;
  return { protocolVersion: 1, pid: 123, permissionProbe: raw };
};
try {
  for (const value of [{inFlight:true,waiters:8,positiveCached:false},
                      {inFlight:false,waiters:0,positiveCached:true}]) {
    raw = value;
    assert.deepEqual((await macosHelper.diagnosticsCommand()).permissionProbe, value);
  }
  for (const value of [undefined, {}, {inFlight:'true',waiters:0,positiveCached:false},
      {inFlight:true,waiters:-1,positiveCached:false},
      {inFlight:true,waiters:1.5,positiveCached:false},
      {inFlight:true,waiters:Infinity,positiveCached:false},
      {inFlight:true,waiters:0,positiveCached:'false'}]) {
    raw = value;
    assert.equal((await macosHelper.diagnosticsCommand()).permissionProbe, undefined);
  }
  assert.equal(calls, 9);
} finally { macosHelper.command = original; }
console.log('Permission probe diagnostics retain valid state, reject malformed state and send only diagnostics');
