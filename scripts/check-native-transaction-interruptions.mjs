// Reproduce a native Cancel closing its source root before a later batch step.
// All native calls are injected: no helper or desktop input is used by this test.
import assert from 'node:assert/strict';
import {parseLookResponse} from '../src/outline.ts';
import {currentPlatformBackend as backend} from '../src/platform/index.ts';
import {executeFind,executeObserve,executeAct,shutdownComputerUseSession} from '../src/bridge.ts';

const original = {...backend};
const root = {kind:'window',rootRef:'dialog-root',windowRef:'dialog-root',windowId:10,pid:7,
 appName:'Fixture',title:'Owned native dialog',zOrder:0,framePoints:{x:0,y:0,w:100,h:100},
 scaleFactor:1,isOnscreen:true,isFocused:true,isMinimized:false,isMain:true,isModal:false};
const other = {...root,rootRef:'other-root',windowRef:'other-root',windowId:11,title:'Other window'};
const call = (fn,params) => fn('native-transaction-regression',params,undefined,undefined,{cwd:process.cwd(),hasUI:false});

async function scenario(mode) {
 let calls=0,observations=0,closed=false;
 Object.assign(backend,{
  name:'windows',actBatch:undefined,
  ensureReady:async()=>({lastPermissionCheckAt:Date.now()}),
  listApps:async()=>[{appName:'Fixture',pid:7}],
  listRoots:async()=>closed?[other]:[root,other],
  getFrontmost:async()=>({appName:'Fixture',pid:7,windowId:10,rootRef:root.rootRef}),
  observe:async()=>{
   observations++;
   return parseLookResponse({lookId:'dialog-look-'+observations,capturedAt:Date.now()/1000,
    window:{windowId:10,framePoints:root.framePoints,scaleFactor:1,isModal:false},
    outline:{ref:'native-cancel',role:'button',title:'Cancel',canPress:true,actions:['press'],children:[]},timings:{}});
  },
  act:async()=>{
   calls++;
   if(mode==='first-error' || mode==='later-error'&&calls===2)
    throw Object.assign(Error('Element reference is stale'),{code:'stale_ref'});
   if(mode==='later-transport'&&calls===2)
    throw Object.assign(Error('Terminal response lost'),{code:'helper_transport_unknown',outcome:'unknown',
     command:'act',requestId:'exact-request',requestWriteAttempted:true});
   if(mode==='closed-without-hint'&&calls===1)closed=true;
   const rootDelta=mode==='stale-close-hint'&&calls===1
    ?[{change:'closed',kind:'window',pid:7,ref:root.rootRef,title:root.title}]:[];
   return {outcome:'worked',performed:{delivery:'ax'},rootDelta};
  },
 });
 try {
  const found=await call(executeFind,{text:root.title});
  const observed=await call(executeObserve,{root:found.details.windows.find(w=>w.windowId===10).windowRef,mode:'semantic'});
  const stateId=observed.details.capture.stateId;
  const ref=observed.details.outline.root.ref;
  const params={stateId,observationMode:'semantic',actions:[{action:'press',ref},{action:'press',ref},{action:'press',ref}]};
  if(mode==='first-error') {
   await assert.rejects(()=>call(executeAct,params),/stale/);
   assert.equal(calls,1,'keep a first-step preflight refusal distinct from a completed prefix');
   return;
  }
  const result=await call(executeAct,params);
  if(mode==='closed-without-hint') {
   assert.equal(calls,1,'do not dispatch the remainder after the exact source root closes');
   assert.equal(result.details.status,'target_closed');
   assert.equal(result.details.execution.steps.length,1,'retain the returned Cancel receipt');
   assert.equal(result.details.execution.steps[0].outcome,'worked');
   assert.equal(observations,1,'a proven closed root must not enter capture again');
   assert(result.details.execution.rootDelta.some(d=>d.metadata?.source==='between_action_identity_probe'));
  } else if(mode==='later-error') {
   assert.equal(calls,2,'never replay the prefix or run the third step');
   assert.equal(result.details.status,'dispatch_outcome_unknown');
   assert.equal(result.details.error.code,'batch_step_unconfirmed');
   assert.equal(result.details.execution.steps[0].outcome,'worked');
   assert.equal(result.details.execution.steps[1].outcome,'unknown');
   assert.deepEqual(result.details.execution.batchFailure,{failedStepIndex:1,returnedPrefixActions:1,causeCode:'stale_ref'});
   assert.equal(result.details.execution.dispatchCompletion,'unknown');
   assert.equal(result.details.execution.inputDispatch,undefined,'an exception cannot invent native cleanup proof');
   assert.equal(result.details.execution.actionCount,undefined);
   assert.equal(observations,1,'unknown completion cannot mint a successor observation');
   assert(result.content.some(c=>c.type==='text'&&c.text.includes('Keep writes quarantined')));
  } else if(mode==='later-transport') {
   assert.equal(calls,2);
   assert.equal(result.details.status,'dispatch_outcome_unknown');
   assert.equal(result.details.execution.transport.requestId,'exact-request');
   assert.equal(result.details.execution.steps[0].outcome,'worked');
   assert.equal(result.details.execution.batchFailure,undefined,'preserve the original transport evidence');
  } else {
   assert.equal(calls,3,'an unproven closure hint must not suppress valid later actions');
   assert.notEqual(result.details.status,'target_closed');
   return;
  }
  const callsBefore=calls;
  await assert.rejects(()=>call(executeAct,params));
  assert.equal(calls,callsBefore,'old state cannot replay a completed or unknown prefix');
 } finally {
  await shutdownComputerUseSession();
 }
}

try {
 for(const mode of ['closed-without-hint','later-error','later-transport','stale-close-hint','first-error'])await scenario(mode);
 console.log('Native transaction interruption regressions passed: closed source, retained prefix, later failure, transport loss, stale hint and no replay');
} finally {
 Object.assign(backend,original);
 await shutdownComputerUseSession();
}
