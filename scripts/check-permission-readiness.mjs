// Newly authored regressions for the current permission readiness contract.
import assert from 'node:assert/strict';
import {ensurePermissions,requestPermissions} from '../src/permissions.ts';
let status={accessibility:false,screenRecording:false},choice='Cancel';
const calls=[];
const bridge={kinds:[{kind:'accessibility',openOption:'Open accessibility'},{kind:'screenRecording',openOption:'Open recording'}],
 copy:{nonInteractiveError:()=> 'Missing permissions in noninteractive mode',incompleteError:()=> 'Missing permissions',prompt:()=> 'Permission prompt',requestOption:'Request',recheckOption:'Recheck',readyMessage:'Ready',stillMissing:()=> 'Still missing'},
 async checkPermissions(){calls.push('check');return {...status};},
 async registerPermissions(){calls.push('register');},
 async openPermissionPane(kind){calls.push('open:'+kind);},
 async restartHelper(){calls.push('restart');status={accessibility:true,screenRecording:true};}};
const ui={async select(){calls.push('select');return choice;},notify(){calls.push('notify');}};
for(const hasUI of [false,true]){
 calls.length=0;
 await assert.rejects(()=>ensurePermissions({hasUI,ui},bridge,'helper'),/Missing permissions/);
 assert.deepEqual(calls,['check'],'readiness must not register, restart, prompt or open settings');
}
status={accessibility:true,screenRecording:false};
await assert.rejects(()=>ensurePermissions({hasUI:false},bridge,'helper'),/Missing/);
status={accessibility:true,screenRecording:true,source:{attribution:'caller',pid:99}};
assert.deepEqual(await ensurePermissions({hasUI:false},bridge,'helper'),status);
status={accessibility:false,screenRecording:false};calls.length=0;
await requestPermissions({hasUI:true,ui},bridge,'helper');
assert.deepEqual(calls,['check','select'],'cancelling must preserve helper/settings');
choice='Recheck';calls.length=0;
assert.equal((await requestPermissions({hasUI:true,ui},bridge,'helper')).screenRecording,true);
assert.deepEqual(calls,['check','select','restart','check','notify']);
status={accessibility:false,screenRecording:false};choice='Request';calls.length=0;
await requestPermissions({hasUI:true,ui},bridge,'helper');
assert.deepEqual(calls,['check','select','register','check','notify']);
choice='Open recording';calls.length=0;
await requestPermissions({hasUI:true,ui},bridge,'helper');
assert.deepEqual(calls,['check','select','open:screenRecording','check','notify']);
const controller=new AbortController();controller.abort();calls.length=0;
await assert.rejects(()=>requestPermissions({hasUI:true,ui},bridge,'helper',controller.signal),/aborted/);
assert(!calls.some(c=>c==='select'||c==='register'||c==='restart'||c.startsWith('open:')));
console.log('Permission readiness regression checks passed (new coverage; no input or settings changes)');
