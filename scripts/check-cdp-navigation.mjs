import assert from 'node:assert/strict';
import {CdpTab} from '../src/cdp.ts';
const tab=Object.create(CdpTab.prototype);
tab.send=async()=>({errorText:'net::ERR_NAME_NOT_RESOLVED'});
await assert.rejects(()=>tab.navigate('https://unavailable.invalid/'),/ERR_NAME_NOT_RESOLVED/,'navigation errors must not be reported as success');
const originalSet=globalThis.setTimeout,originalClear=globalThis.clearTimeout;
const active=new Set();
globalThis.setTimeout=(fn,ms,...args)=>{const timer=originalSet(fn,ms,...args);active.add(timer);return timer;};
globalThis.clearTimeout=timer=>{active.delete(timer);originalClear(timer);};
try{
 tab.send=async(method,params,timeoutMs)=>{assert.equal(method,'Page.navigate');assert.equal(timeoutMs,20000);tab.loadFired();return {frameId:'owned-frame'};};
 await tab.navigate('https://example.com/');
 assert.equal(active.size,0,'successful load must clear its fallback timer');
 assert.equal(tab.loadFired,undefined);
 console.log('CDP navigation error and timer lifecycle checks passed');
}finally{for(const timer of active)originalClear(timer);globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;}
