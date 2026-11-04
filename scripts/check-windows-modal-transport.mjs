// Exercise the real Windows helper transport and backend against a controllable
// subprocess. The fixture never sends desktop input.
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "pi-modal-helper-"));
const helperPath = path.join(temporary, "fake-windows-helper");
await fs.writeFile(helperPath, `#!/usr/bin/env node
const readline = require('node:readline');
let modalOpen = false, original, dispatches = 0;
const parent = () => ({kind:'window',rootRef:'@w10',windowRef:'@w10',windowId:10,pid:7,title:'Caption',isOnscreen:true,isFocused:!modalOpen,isMain:true,isModal:false,framePoints:{x:0,y:0,w:300,h:200},metadata:{className:'fixture',interaction:{enabled:!modalOpen}}});
const modal = () => ({kind:'popover',rootRef:'@w20',windowRef:'@w20',windowId:20,pid:7,title:'New Label',isOnscreen:true,isFocused:true,isMain:true,isModal:true,framePoints:{x:0,y:0,w:200,h:100},metadata:{className:'fixture',interaction:{enabled:true,ownerHwnd:10,ownerDisabled:true}}});
const send = (r,result) => process.stdout.write(JSON.stringify({id:r.id,protocolVersion:r.protocolVersion,ok:true,result})+'\\n');
readline.createInterface({input:process.stdin}).on('line', line => {
 const r=JSON.parse(line);
 if(r.cmd==='listRoots') return send(r,{roots:modalOpen?[parent(),modal()]:[parent()]});
 if(r.cmd==='act') {
  dispatches++; original=r;
  process.stderr.write(JSON.stringify({event:'cu_action_phase',requestId:r.id,stage:'native_mutation_started',elapsedMs:3})+'\\n');
  modalOpen=true;
  return;
 }
 if(r.cmd==='close-test-modal') {
  modalOpen=false;
  if(original) { send(original,{outcome:'worked',performed:{delivery:'ax'}}); original=undefined; }
  return send(r,{dispatches});
 }
 send(r,{});
});
`, { mode: 0o755 });

const previous = process.env.PI_COMPUTER_USE_WINDOWS_HELPER_PATH;
process.env.PI_COMPUTER_USE_WINDOWS_HELPER_PATH = helperPath;
const { windowsHelper } = await import("../src/platform/windows/helper.ts");
const { windowsBackend } = await import("../src/platform/windows/backend.ts");
windowsHelper.ensureInstalled = async () => {};
try {
	const result = await windowsBackend.actWithModal({
		lookId: "look-1", pid: 7, action: "press", target: { ref: "button" },
		policy: "background", params: { button: "left", clickCount: 1, delivery: "pid" },
	}, 10, { timeoutMs: 1_500 });
	assert.equal(result.kind, "modal_pending");
	assert.equal(result.pending.modal.windowId, 20);
	assert.match(result.pending.requestId, /^[a-f0-9-]+$/);
	const closed = await windowsHelper.command("close-test-modal");
	assert.equal(closed.dispatches, 1, "the transport must not replay the original press");
	assert.equal((await result.pending.completion).outcome, "worked");
	console.log("Windows modal observer and original completion passed over a real helper subprocess (no desktop input).");
} finally {
	windowsHelper.dispose();
	if (previous === undefined) delete process.env.PI_COMPUTER_USE_WINDOWS_HELPER_PATH;
	else process.env.PI_COMPUTER_USE_WINDOWS_HELPER_PATH = previous;
	await fs.rm(temporary, { recursive: true, force: true });
}
