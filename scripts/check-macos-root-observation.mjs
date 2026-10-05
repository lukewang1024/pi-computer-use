import assert from 'node:assert/strict';
import {macosBackend} from '../src/platform/macos/backend.ts';
import {macosHelper} from '../src/platform/macos/helper.ts';

// Exercise the real backend boundary without starting a helper or sending input.
// AX-only dialogs have no Quartz ID: losing their native ref makes look fail.
const original = macosHelper.command;
const requests = [];
macosHelper.command = async (name, params) => {
  requests.push({name, params});
  assert.equal(name, 'look');
  if (!params.windowRef) throw Error('Root is not owned by a running app');
  return {
    lookId: 'controlled-ax-root', capturedAt: 1,
    window: {windowId: 0, rootRef: params.windowRef},
    outline: {ref: params.windowRef, role: 'AXWindow', subrole: 'AXSystemDialog', children: []},
    timings: {},
  };
};
try {
  for (const target of [
    {pid: 100031, windowId: 0, windowRef: 'native-dialog'},
    {pid: 100031, windowId: 0, rootRef: 'legacy-native-dialog'},
    {pid: 100031, windowId: 0, windowRef: 'exact-dialog', rootRef: 'different-dialog'},
  ]) {
    const observed = await macosBackend.observe({target, includeImage: false, readText: 'never'});
    const wire = target.windowRef ?? target.rootRef;
    assert.equal(requests.at(-1).params.windowRef, wire);
    assert.equal(requests.at(-1).params.windowId, 0);
    assert.equal(requests.at(-1).params.includeImage, false);
    assert.equal(requests.at(-1).params.readText, 'never');
    assert.equal(observed.window.rootRef, wire);
    assert.equal(observed.outline.role, 'AXWindow');
  }
  assert.equal(requests.length, 3, 'one original native read per observation; no fallback retry');
  console.log('Mac AX-only root observation boundary passed; no helper or input');
} finally {
  macosHelper.command = original;
}
