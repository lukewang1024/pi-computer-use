import assert from 'node:assert/strict';
import { ensureMacosReady } from '../src/platform/macos/permissions.ts';
import { macosHelper } from '../src/platform/macos/helper.ts';
const keys=['ensureInstalled','ensureDaemon','ensureProtocol','command'];
const original=Object.fromEntries(keys.map(k=>[k,macosHelper[k]]));
let accessibility=true,screenRecording=false,commands=0;
Object.assign(macosHelper,{
 async ensureInstalled(){},async ensureDaemon(){return true;},
 async ensureProtocol(){return {protocolVersion:6,architectureVersion:1,invariants:['state-scoped-observations','bounded-observation-history','multi-root-forest','progressive-disclosure','atomic-physical-input','concurrent-requests','transactional-batching'],accessibility,screenRecording};},
 async command(){commands++;throw new Error('readiness must not capture or request permission');},
});
try{
 const state={lastPermissionCheckAt:0};
 let value=await ensureMacosReady({hasUI:false},state);
 assert.equal(value.permissionStatus.accessibility,true);
 assert.equal(value.permissionStatus.screenRecording,false);
 screenRecording=true;value=await ensureMacosReady({hasUI:false},state);
 assert.equal(value.permissionStatus.screenRecording,true);
 accessibility=false;await assert.rejects(()=>ensureMacosReady({hasUI:false},state),/Accessibility is unavailable/);
 assert.equal(commands,0);
 console.log('actual macOS readiness uses passive diagnostics; AX requires no capture readiness');
}finally{Object.assign(macosHelper,original);}
