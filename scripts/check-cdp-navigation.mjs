import assert from 'node:assert/strict';
import {CdpTab} from '../src/cdp.ts';
import {CdpNavigationFailure} from '../src/navigation-failure.ts';
import {boundToolError} from '../src/output.ts';
const tab=Object.create(CdpTab.prototype);
tab.send=async()=>({errorText:'net::ERR_NAME_NOT_RESOLVED'});
await assert.rejects(()=>tab.navigate('https://unavailable.invalid/'),/ERR_NAME_NOT_RESOLVED/,'navigation errors must not be reported as success');
let sent=0;
const timeout=new Error("CDP command 'Page.navigate' timed out after 20000ms");
tab.send=async()=>{sent++;throw timeout;};
await assert.rejects(()=>tab.navigate('https://example.com/'),error=>{
 assert(error instanceof CdpNavigationFailure);
 assert.equal(error.cause,timeout);
 assert.equal(error.navigationFailure.physicalInputDispatched,false);
 assert.equal(error.navigationFailure.navigationOutcome,'unknown');
 assert.equal(error.navigationFailure.retrySafe,false);
 assert(Object.isFrozen(error.navigationFailure));
 return true;
});
assert.equal(sent,1,'Navigation failure must not trigger a replay');
assert.equal(tab.loadFired,undefined,'Failed navigation must release its listener');
const long=new CdpNavigationFailure(new Error('x'.repeat(100000)));
const bounded=boundToolError('navigate_browser',long);
assert.equal(bounded.cause,long,'Compaction must retain trusted provenance in the original cause');
const originalSet=globalThis.setTimeout,originalClear=globalThis.clearTimeout;
const active=new Set();
globalThis.setTimeout=(fn,ms,...args)=>{const timer=originalSet(fn,ms,...args);active.add(timer);return timer;};
globalThis.clearTimeout=timer=>{active.delete(timer);originalClear(timer);};
try{
 tab.send=async(method,params,timeoutMs)=>{assert.equal(method,'Page.navigate');assert.equal(timeoutMs,20000);tab.loadFired();return {frameId:'owned-frame'};};
 await tab.navigate('https://example.com/');
 assert.equal(active.size,0,'successful load must clear its fallback timer');
 assert.equal(tab.loadFired,undefined);
 tab.send=async()=>{queueMicrotask(()=>tab.notifyDisconnected());return {frameId:'owned-frame'};};
 await assert.rejects(()=>tab.navigate('https://example.com/'),error=>{
  assert(error instanceof CdpNavigationFailure);
  assert.match(error.message,/closed during navigation/);
  assert.equal(error.navigationFailure.retrySafe,false);
  return true;
 });
 assert.equal(active.size,0,'Disconnect must clear the load timer rather than wait ten seconds');
 assert.equal(tab.loadFired,undefined);
 console.log('CDP navigation error and timer lifecycle checks passed');
}finally{for(const timer of active)originalClear(timer);globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;}
