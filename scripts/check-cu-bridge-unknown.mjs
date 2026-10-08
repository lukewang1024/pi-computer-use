// Newly authored public-executor regression. Native platform operations are
// injected; no helper or desktop input is launched by this test.
import assert from 'node:assert/strict';
import {parseLookResponse} from '../src/outline.ts';
import {currentPlatformBackend as backend} from '../src/platform/index.ts';
import {executeFind,executeObserve,executeSearchUi,executeAct,shutdownComputerUseSession} from '../src/bridge.ts';
const root={kind:'window',rootRef:'native-root',windowRef:'native-root',windowId:10,pid:7,appName:'Fixture',title:'Owned fixture',zOrder:0,framePoints:{x:0,y:0,w:100,h:100},scaleFactor:1,isOnscreen:true,isFocused:true,isMinimized:false,isMain:true,isModal:false};
let dispatches=0;
const overrides={ensureReady:async()=>({lastPermissionCheckAt:Date.now()}),listApps:async()=>[{appName:'Fixture',pid:7}],listRoots:async()=>[root],getFrontmost:async()=>({appName:'Fixture',pid:7,windowId:10,rootRef:'native-root'}),
 observe:async()=>parseLookResponse({lookId:'fixture-look',capturedAt:Date.now()/1000,window:{windowId:10,framePoints:root.framePoints,scaleFactor:1,isModal:false},outline:{ref:'native-button',role:'button',title:'Submit',canPress:true,actions:['press'],children:[]},timings:{}}),
 act:async()=>{dispatches++;throw Object.assign(new Error('Response lost after write'),{code:'helper_transport_unknown',outcome:'unknown',command:'act',requestId:'request-exact',requestWriteAttempted:true,stages:[{stage:'native_mutation_started',elapsedMs:12,secret:'drop-me'},{stage:'untrusted-stage',elapsedMs:13}]});},actBatch:undefined};
const original=Object.fromEntries(Object.keys(overrides).map(key=>[key,backend[key]]));Object.assign(backend,overrides);
const call=(fn,params)=>fn('unknown-regression',params,undefined,undefined,{cwd:process.cwd(),hasUI:false});
try{
 const roots=await call(executeFind,{text:'Owned fixture'});
 const observation=await call(executeObserve,{root:roots.details.windows[0].windowRef,mode:'semantic'});
 const search=await call(executeSearchUi,{stateId:observation.details.capture.stateId,text:'Submit',role:'button'});
 assert.equal(search.details.matches.length,1);
 const result=await call(executeAct,{stateId:observation.details.capture.stateId,actions:[{action:'press',ref:search.details.matches[0].ref},{action:'press',ref:search.details.matches[0].ref}]});
 assert.equal(dispatches,1,'unknown first delivery must stop the remainder and never replay');
 assert.equal(result.details.status,'dispatch_outcome_unknown');
 assert.deepEqual(result.details.execution.transport.stages,[{stage:'native_mutation_started',elapsedMs:12}]);
 assert.equal(result.details.stateId,undefined,'unknown delivery must not create successor state');
 assert(result.content.some(c=>c.type==='text'&&c.text.includes('Do not retry')));
 await assert.rejects(()=>call(executeAct,{stateId:observation.details.capture.stateId,actions:[{action:'press',ref:search.details.matches[0].ref}]}));
 assert.equal(dispatches,1,'old observation must not authorize another input');
 console.log('CU public executor unknown-delivery regression passed (new coverage; injected native backend)');
}finally{Object.assign(backend,original);await shutdownComputerUseSession();}
