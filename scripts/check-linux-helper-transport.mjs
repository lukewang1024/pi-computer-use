// Real subprocess transport faults, including the public executor's no-replay
// boundary. The subprocess records protocol receipt but sends no desktop input.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LinuxHelperClient } from '../src/platform/linux/helper.ts';
import { parseLookResponse } from '../src/outline.ts';
import { currentPlatformBackend as backend } from '../src/platform/index.ts';
import { executeFind, executeObserve, executeSearchUi, executeAct, shutdownComputerUseSession } from '../src/bridge.ts';

const cache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
await fs.mkdir(cache, { recursive: true });
const directory = await fs.mkdtemp(path.join(cache, 'cu-linux-transport-test-'));
const audit = path.join(directory, 'receipts.jsonl');
const helper = path.join(directory, 'helper');
await fs.writeFile(audit, '');
await fs.writeFile(helper, `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
readline.createInterface({input: process.stdin}).on('line', line => {
 const r = JSON.parse(line);
 fs.appendFileSync(${JSON.stringify(audit)}, JSON.stringify({id:r.id,cmd:r.cmd})+'\\n');
 if (r.cmd === 'act') return;
 if (r.cmd === 'exit') return process.exit(0);
 const response = r.cmd === 'native-reject'
  ? {id:r.id,protocolVersion:4,ok:false,error:{code:'stale_element',message:'Fixture element is stale'}}
  : {id:r.id,protocolVersion:r.cmd === 'wrong-version' ? 99 : 4,ok:true,result:r.args.value};
 setTimeout(() => process.stdout.write(JSON.stringify(response)+'\\n'), r.args.delay || 0);
});
`, { mode: 0o755 });
const client = new LinuxHelperClient({ helperPath: helper });
client.ensureInstalled = async () => {};
const receipts = async () => (await fs.readFile(audit, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const waitForReceipt = async count => {
 const deadline = Date.now() + 2000;
 while ((await receipts()).length < count) {
  assert(Date.now() < deadline, 'fixture did not receive the expected request');
  await new Promise(resolve => setTimeout(resolve, 5));
 }
};
const unknown = (error, command) => {
 assert.equal(error.code, 'helper_transport_unknown');
 assert.equal(error.outcome, 'unknown');
 assert.equal(error.command, command);
 assert.equal(error.requestWriteAttempted, true);
 assert.equal(typeof error.requestId, 'string');
 return true;
};
let original;
try {
 assert.equal(await client.command('echo', { value: 'warm' }), 'warm');
 const beforeCancellation = (await receipts()).length;
 const cancelled = new AbortController(); cancelled.abort();
 await assert.rejects(() => client.command('echo', { value: 'must-not-send' }, { signal: cancelled.signal }), /before dispatch/);
 // Exercise cancellation during the await with an already running helper.
 const duringStartup = new AbortController();
 client.ensureInstalled = async () => { duringStartup.abort(); };
 await assert.rejects(() => client.command('echo', { value: 'must-not-send-after-await' }, { signal: duringStartup.signal }), /before dispatch/);
 client.ensureInstalled = async () => {};
 assert.equal((await receipts()).length, beforeCancellation, 'pre-dispatch cancellations must not write requests');

 await assert.rejects(() => client.command('act', {}, { timeoutMs: 100 }), error => unknown(error, 'act'));
 const cancellation = new AbortController();
 const count = (await receipts()).length;
 const pending = client.command('act', {}, { signal: cancellation.signal, timeoutMs: 3000 }).catch(error => error);
 await waitForReceipt(count + 1); cancellation.abort();
 unknown(await pending, 'act');
 assert.equal(await client.command('echo', { value: 'still-alive' }), 'still-alive', 'one cancellation must not kill unrelated requests');
 await assert.rejects(() => client.command('echo', { value: 'late', delay: 60 }, { timeoutMs: 10 }), error => unknown(error, 'echo'));
 await new Promise(resolve => setTimeout(resolve, 80));
 assert.equal(await client.command('echo', { value: 'after-late' }), 'after-late', 'late replies must not resolve another request');
 await assert.rejects(() => client.command('wrong-version'), error => unknown(error, 'wrong-version'));
 await assert.rejects(() => client.command('native-reject'), error => {
  assert.equal(error.code, 'stale_element'); assert.equal(error.outcome, undefined); return true;
 });
 await assert.rejects(() => client.command('exit'), error => unknown(error, 'exit'));
 assert.equal(await client.command('echo', { value: 'fresh-process' }), 'fresh-process');

 // Use the actual client error, rather than synthesizing it in the backend.
 const root = { kind:'window',rootRef:'native-root',windowRef:'native-root',windowId:10,pid:7,appName:'Fixture',title:'Owned fixture',zOrder:0,framePoints:{x:0,y:0,w:100,h:100},scaleFactor:1,isOnscreen:true,isFocused:true,isMinimized:false,isMain:true,isModal:false };
 const overrides = {
  ensureReady:async()=>({lastPermissionCheckAt:Date.now()}),listApps:async()=>[{appName:'Fixture',pid:7}],listRoots:async()=>[root],getFrontmost:async()=>({appName:'Fixture',pid:7,windowId:10,rootRef:'native-root'}),
  observe:async()=>parseLookResponse({lookId:'fixture-look',capturedAt:Date.now()/1000,window:{windowId:10,framePoints:root.framePoints,scaleFactor:1,isModal:false},outline:{ref:'native-button',role:'button',title:'Submit',canPress:true,actions:['press'],children:[]},timings:{}}),
  act:()=>client.command('act', {}, { timeoutMs:100 }),actBatch:undefined,
 };
 original = Object.fromEntries(Object.keys(overrides).map(key => [key, backend[key]])); Object.assign(backend, overrides);
 const call = (fn, params) => fn('linux-unknown-regression',params,undefined,undefined,{cwd:process.cwd(),hasUI:false});
 const roots = await call(executeFind, { text:'Owned fixture' });
 const observation = await call(executeObserve, { root:roots.details.windows[0].windowRef,mode:'semantic' });
 const search = await call(executeSearchUi, { stateId:observation.details.capture.stateId,text:'Submit',role:'button' });
 assert.equal(search.details.matches.length, 1);
 const actions = [{action:'press',ref:search.details.matches[0].ref},{action:'press',ref:search.details.matches[0].ref}];
 const previousActs = (await receipts()).filter(r => r.cmd === 'act').length;
 const result = await call(executeAct, {stateId:observation.details.capture.stateId,actions});
 assert.equal(result.details.status, 'dispatch_outcome_unknown');
 assert.equal(result.details.stateId, undefined);
 assert(result.content.some(c => c.type === 'text' && c.text.includes('Do not retry')));
 assert.equal((await receipts()).filter(r => r.cmd === 'act').length, previousActs + 1, 'unknown input must stop the batch');
 await assert.rejects(() => call(executeAct, {stateId:observation.details.capture.stateId,actions:actions.slice(0,1)}));
 assert.equal((await receipts()).filter(r => r.cmd === 'act').length, previousActs + 1, 'old observations must not authorize more input');
 Object.assign(backend, original); original = undefined;
 await shutdownComputerUseSession();

 const beforeDispose = (await receipts()).length;
 const disposed = client.command('act', {}, { timeoutMs:3000 }).catch(error => error);
 await waitForReceipt(beforeDispose + 1); client.dispose();
 unknown(await disposed, 'act');
 const all = await receipts();
 assert.equal(new Set(all.map(r => r.id)).size, all.length, 'no request ID may be replayed');
 console.log('Linux real subprocess unknown-delivery and public no-replay checks passed (no desktop input)');
} finally {
 if (original) Object.assign(backend, original);
 await shutdownComputerUseSession();
 client.dispose();
 await fs.rm(directory, {recursive:true,force:true});
}
