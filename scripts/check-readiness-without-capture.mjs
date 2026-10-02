// Newly authored readiness regressions with helper protocol methods injected.
import assert from 'node:assert/strict';
import {windowsBackend} from '../src/platform/windows/backend.ts';
import {windowsHelper} from '../src/platform/windows/helper.ts';
import {linuxBackend} from '../src/platform/linux/backend.ts';
import {linuxHelper} from '../src/platform/linux/helper.ts';
import {PLATFORM_ARCHITECTURE_VERSION,REQUIRED_PLATFORM_INVARIANTS} from '../src/platform/architecture.ts';
for(const [backend,helper] of [[windowsBackend,windowsHelper],[linuxBackend,linuxHelper]]){
 const original={ensureInstalled:helper.ensureInstalled,command:helper.command};const calls=[];
 let diagnostics={protocolVersion:4,architectureVersion:PLATFORM_ARCHITECTURE_VERSION,invariants:[...REQUIRED_PLATFORM_INVARIANTS],pid:1,accessibility:true};
 helper.ensureInstalled=async()=>{calls.push('installed');};
 helper.command=async cmd=>{calls.push(cmd);assert.equal(cmd,'diagnostics','readiness must not capture or input');return diagnostics;};
 try{
  const ready=await backend.ensureReady({hasUI:false},{lastPermissionCheckAt:0});
  assert(ready.lastPermissionCheckAt>0);assert.equal(ready.helperDiagnostics.pid,1);
  assert.deepEqual(calls,['installed','diagnostics']);
  diagnostics={...diagnostics,protocolVersion:99};
  await assert.rejects(()=>backend.ensureReady({hasUI:false},{lastPermissionCheckAt:0}),/protocol mismatch/);
  diagnostics={...diagnostics,protocolVersion:4,invariants:[]};
  await assert.rejects(()=>backend.ensureReady({hasUI:false},{lastPermissionCheckAt:0}),/shared computer-use contract/);
 }finally{Object.assign(helper,original);}
}
console.log('Readiness without capture checks passed (new coverage; injected helpers)');
