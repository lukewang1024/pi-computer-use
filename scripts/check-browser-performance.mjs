import assert from 'node:assert/strict';
import vm from 'node:vm';
import {BROWSER_PERFORMANCE_SAMPLE,navigateWithPerformance,readBrowserMetrics,summarizeBrowserPerformance} from '../src/browser-performance.ts';
let calls=[];
const deps={navigate:async()=>{calls.push('navigate');return true;},evaluate:async()=>{calls.push('metrics');return {value:{navigation:{}}};},refresh:async()=>{calls.push('refresh');return {stateId:'new'};}};
assert.deepEqual((await navigateWithPerformance('owned','https://example.com/',false,deps)).observation,{stateId:'new'});
assert.deepEqual(calls,['navigate','refresh']);
calls=[];
const result=await navigateWithPerformance('owned','https://example.com/',true,deps);
assert(result.performanceSample);assert.deepEqual(calls,['navigate','metrics','refresh']);
calls=[];
const failed=await navigateWithPerformance('owned','https://example.com/',true,{...deps,evaluate:async()=>{calls.push('metrics');throw Error('x'.repeat(2000));}});
assert.equal(failed.performanceError.message.length,1024);assert.deepEqual(calls,['navigate','metrics','refresh']);
calls=[];
await assert.rejects(()=>navigateWithPerformance('owned','https://example.com/','yes',deps),/boolean/);
assert.deepEqual(calls,[]);
calls=[];
await assert.rejects(()=>navigateWithPerformance('owned','https://example.com/',true,{...deps,navigate:async()=>{calls.push('navigate');throw Error('navigation unknown');}}),/navigation unknown/);
assert.deepEqual(calls,['navigate']);
let disconnected=0;
class Observer{
 static supportedEntryTypes=['paint','event','longtask'];
 constructor(callback){this.callback=callback;}
 observe({type}){if(type==='event')throw Error('unsupported');this.type=type;this.callback({getEntries:()=>Array.from({length:70},()=>({name:'a'.repeat(300),startTime:1,duration:60}))});}
 takeRecords(){return [];}
 disconnect(){disconnected++;}
}
const context={PerformanceObserver:Observer,performance:{now:()=>10,timeOrigin:100,getEntriesByType:type=>type==='navigation'?[{type:'navigate',duration:30,domainLookupEnd:0,domainLookupStart:0,connectEnd:0,connectStart:0,responseStart:1,requestStart:0,domContentLoadedEventEnd:20,loadEventEnd:30,transferSize:0}]:[]},document:{readyState:'complete',visibilityState:'visible'},location:{origin:'https://example.com',pathname:'/'},setTimeout:fn=>{fn();return 1;}};
const sample=await vm.runInNewContext(BROWSER_PERFORMANCE_SAMPLE,context);
assert.equal(sample.observation.entries.longtask.length,64);
assert.equal(sample.observation.entries.longtask[0].name.length,128);
assert.equal(sample.observation.truncated,true);
assert(!sample.observation.supported.includes('event'),'failed observer must not falsely report zero latency');
assert(sample.observation.failures.event);assert(disconnected>=3);
assert.equal(sample.navigation.navigation.transferBytes,0,'zero reported transfer remains zero, not inferred failure');
assert.equal(sample.loadWait.complete,true);
const summary=summarizeBrowserPerformance(sample);
assert.equal(summary.finalCoreWebVitals,false);
assert.equal(summary.pageHealth,'not-assessed');
assert.equal(summary.observation.entryCounts.longtask,64);
assert(!Object.hasOwn(summary.observation.entryCounts,'event'),'unsupported empty buffer must not become a zero count');
assert(!Object.hasOwn(summary.observation,'entries'),'model summary should not repeat full entry arrays');

// A slow page must produce an incomplete sample before Runtime.evaluate's
// 5-second deadline, not race the CDP deadline with a 5-second in-page wait.
let clock=0;
const slow={...context,document:{readyState:'interactive',visibilityState:'visible',title:'x'.repeat(2000),querySelector:()=>({textContent:'h'.repeat(2000)})},performance:{...context.performance,now:()=>clock},location:{...context.location,href:'https://example.com/'},setTimeout:fn=>{clock+=100;fn();return 1;}};
const incomplete=await vm.runInNewContext(BROWSER_PERFORMANCE_SAMPLE,slow);
assert.equal(incomplete.loadWait.complete,false);assert.equal(incomplete.loadWait.budgetMs,3000);
assert(clock>=3000&&clock<5000,'Leave time for observer flush and CDP transport');
assert.equal(incomplete.documentIdentity.consistent,true);
assert.equal(incomplete.documentIdentity.title.length,512);assert.equal(incomplete.documentIdentity.heading.length,512);
const fixedCalls=[];
const read=await readBrowserMetrics('exact',async(id,expression)=>{fixedCalls.push({id,expression});return {value:incomplete};});
assert.equal(read.readOnly,true);assert.equal(read.performanceSample.loadWait.complete,false);
assert.deepEqual(fixedCalls,[{id:'exact',expression:BROWSER_PERFORMANCE_SAMPLE}]);
const drift=await readBrowserMetrics('exact',async()=>({value:{...incomplete,documentIdentity:{consistent:false}}}));
assert.equal(drift.performanceSample,undefined);assert.match(drift.performanceError.message,/identity/);
const readFailure=await readBrowserMetrics('exact',async()=>{throw Error('x'.repeat(2000));});
assert.equal(readFailure.readOnly,true);assert.equal(readFailure.performanceError.message.length,1024);
assert.equal(readFailure.performanceError.completion,'unconfirmed');
assert.equal((await readBrowserMetrics('missing',async()=>undefined)).performanceSample,undefined);

let driftClock=0;
const moved={...slow,location:{...slow.location},performance:{...slow.performance,now:()=>driftClock},setTimeout:fn=>{driftClock+=100;moved.location.href='https://example.com/other';fn();return 1;}};
const actualDrift=await vm.runInNewContext(BROWSER_PERFORMANCE_SAMPLE,moved);
assert.equal(actualDrift.documentIdentity.consistent,false,'The fixed production collector must detect navigation during its await');
assert.equal((await readBrowserMetrics('exact',async()=>({value:actualDrift}))).performanceSample,undefined);
console.log('Bounded browser performance and no-navigation-replay checks passed');
