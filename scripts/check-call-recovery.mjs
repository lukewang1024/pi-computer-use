// Public executor + scheduler tests with injected platform operations only.
// No native helper is started and no desktop input is sent.
import assert from 'node:assert/strict';
import {ActionPreflightError,NativeActionPreflightError} from '../src/action-preflight.ts';
import {ResourceScheduler,runPreflightWrite,StaleResourceStateError} from '../src/runtime.ts';
import {parseLookResponse} from '../src/outline.ts';
import {currentPlatformBackend as backend} from '../src/platform/index.ts';
import {executeFind,executeObserve,executeSearchUi,executeAct,shutdownComputerUseSession} from '../src/bridge.ts';

const proof=(error,recovery)=>{
 assert.equal(error.code,'cu_preflight_rejected');
 assert.deepEqual(error.preflight,{version:1,phase:'before_input',inputDispatched:false,recoverable:true,recovery});
 return true;
};
const scheduler=new ResourceScheduler();let writes=0;
try{
 await assert.rejects(runPreflightWrite(scheduler,'fixture',0,()=>{throw Error('Invalid later action');},async()=>writes++),error=>proof(error,'correct_call'));
 assert.equal(writes,0);assert.equal(scheduler.epoch('fixture'),0,'rejected preflight must not consume its state');
 await runPreflightWrite(scheduler,'fixture',0,()=>{},async()=>writes++);
 await assert.rejects(runPreflightWrite(scheduler,'fixture',0,()=>{},async()=>writes++),error=>proof(error,'observe_ui'));
 assert.equal(writes,1,'stale scheduler state must reject before entering work');
 const afterEntry=new StaleResourceStateError('fixture',0,1);
 await assert.rejects(runPreflightWrite(scheduler,'fixture',1,()=>{},async()=>{throw afterEntry;}),error=>{
  assert.equal(error,afterEntry);assert.equal(error.preflight,undefined,'errors after entering work must not acquire a no-input proof');return true;
 });
}finally{await scheduler.close();}

const root={kind:'window',rootRef:'native-root',windowRef:'native-root',windowId:10,pid:7,appName:'Fixture',title:'Recovery fixture',zOrder:0,framePoints:{x:0,y:0,w:100,h:100},scaleFactor:1,isOnscreen:true,isFocused:true,isMinimized:false,isMain:true,isModal:false};
const sent=[];
const overrides={name:'windows',ensureReady:async()=>({lastPermissionCheckAt:Date.now()}),listApps:async()=>[{appName:'Fixture',pid:7}],listRoots:async()=>[root],getFrontmost:async()=>({appName:'Fixture',pid:7,windowId:10,rootRef:'native-root'}),
 observe:async()=>parseLookResponse({lookId:'fixture-look',capturedAt:Date.now()/1000,window:{windowId:10,framePoints:root.framePoints,scaleFactor:1,isModal:false},outline:{ref:'fixture-body',role:'group',rect:{x:0,y:0,w:100,h:100},children:[
  {ref:'native-editor',role:'textbox',title:'Editor',canSetValue:true,isTextInput:true,rect:{x:10,y:10,w:80,h:40},actions:['set_text'],children:[]},
  {ref:'native-link',role:'button',title:'Link',canPress:true,rect:{x:10,y:60,w:80,h:20},actions:['press'],children:[]},
 ]},timings:{}}),
 act:async request=>{sent.push(request);return {outcome:'worked',performed:{delivery:'hid'}};},actBatch:undefined};
const original=Object.fromEntries(Object.keys(overrides).map(key=>[key,backend[key]]));Object.assign(backend,overrides);
const call=(fn,params)=>fn('call-recovery',params,undefined,undefined,{cwd:process.cwd(),hasUI:false});
try{
 const roots=await call(executeFind,{text:'Recovery fixture'});
 const observed=await call(executeObserve,{root:roots.details.windows[0].windowRef,mode:'semantic'});
 const stateId=observed.details.capture.stateId;
 const search=await call(executeSearchUi,{stateId,text:'Editor',role:'textbox'});
 const ref=search.details.matches[0].ref;
 // Both are ordinary caller mistakes. Reject the whole batch before its first
 // native request, then allow a corrected call on the same original state.
 await assert.rejects(call(executeAct,{stateId,actions:[{action:'click',ref},{action:'keypress',keys:['unsupported-key']}]}),error=>proof(error,'correct_call'));
 await assert.rejects(call(executeAct,{stateId,actions:[{action:'click',x:20,y:30}]}),error=>proof(error,'observe_visual'));
 await assert.rejects(call(executeAct,{stateId,actions:[{action:'click',ref:'@e99999'}]}),error=>proof(error,'observe_ui'));
 await assert.rejects(call(executeAct,{stateId,actions:[{action:'click',ref}],observationMode:'pixels',expect:{text:'done'}}),error=>proof(error,'correct_call'));
 assert.equal(sent.length,0,'invalid calls must not reach the native helper');
 const corrected=await call(executeAct,{stateId,actions:[{action:'click',ref}],observationMode:'semantic'});
 assert.equal(sent.length,1,'the corrected ref click is dispatched exactly once');
 assert.deepEqual(sent[0].target,{ref:'native-editor'});
 assert.equal(corrected.details.execution.outcome,'worked');
 assert.notEqual(corrected.details.capture.stateId,stateId);
 await assert.rejects(call(executeAct,{stateId,actions:[{action:'click',ref}]}),error=>proof(error,'observe_ui'));
 assert.equal(sent.length,1,'a consumed state must never authorize a replay');
 assert.equal(new ActionPreflightError('Invalid').preflight.inputDispatched,false);

 const fresh=async text=>{
  const observed=await call(executeObserve,{root:roots.details.windows[0].windowRef,mode:'semantic'});
  const stateId=observed.details.capture.stateId;
  const searched=await call(executeSearchUi,{stateId,text,role:text==='Editor'?'textbox':'button'});
  assert.equal(searched.details.matches.length,1);
  return {stateId,ref:searched.details.matches[0].ref};
 };
 let current=await fresh('Editor');
 let rejectedNativeCalls=0;
 backend.act=async()=>{rejectedNativeCalls++;throw new NativeActionPreflightError('Target is occluded','occluded_target');};
 await assert.rejects(call(executeAct,{stateId:current.stateId,actions:[{action:'click',ref:current.ref}],observationMode:'semantic'}),error=>proof(error,'observe_ui'));
 await assert.rejects(call(executeAct,{stateId:current.stateId,actions:[{action:'click',ref:current.ref}],observationMode:'semantic'}),error=>proof(error,'observe_ui'));
 assert.equal(rejectedNativeCalls,1,'a native preflight consumes its write epoch; stale-state reuse must stop before another native request');
 current=await fresh('Editor');
 backend.act=overrides.act;
 const continued=await call(executeAct,{stateId:current.stateId,actions:[{action:'click',ref:current.ref}],observationMode:'semantic'});
 assert.equal(continued.details.execution.outcome,'worked','a new observation permits a corrected operation in the same session');

 for(const provedFirst of [true,false]){
  current=await fresh('Link');
  const policies=[];
  backend.act=async request=>{
   policies.push(request.policy);
   if(request.policy==='background'){
    if(provedFirst)throw new NativeActionPreflightError('Foreground required','foreground_required');
    throw Object.assign(new Error('Foreground required'),{code:'foreground_required'});
   }
   throw new NativeActionPreflightError('Target is occluded','occluded_target');
  };
  await assert.rejects(call(executeAct,{stateId:current.stateId,actions:[{action:'click',ref:current.ref}],observationMode:'semantic'}),error=>{
   if(provedFirst)return proof(error,'observe_ui');
   assert.equal(error.preflight,undefined);assert.equal(error.code,'native_prefix_unconfirmed');assert.equal(error.outcome,'unknown');return true;
  });
  assert.deepEqual(policies,['background','foreground']);
 }

 // A Windows secondary gesture must survive the pre-input foreground
 // escalation without being changed into a primary semantic activation.
 for(const operation of ['click','press']){
  current=await fresh('Link');
  const attempts=[];
  backend.act=async request=>{
   attempts.push(request);
   if(request.policy==='background')throw new NativeActionPreflightError('Foreground required','foreground_required');
   return {outcome:'unknown',performed:{delivery:'hid'}};
  };
  const result=await call(executeAct,{stateId:current.stateId,
   actions:[{action:operation,ref:current.ref,button:'right',clickCount:1}],observationMode:'semantic'});
  assert.deepEqual(attempts.map(x=>x.policy),['background','foreground']);
  for(const request of attempts){
   assert.equal(request.action,operation);
   assert.deepEqual(request.target,{ref:'native-link'});
   assert.equal(request.params.button,'right');
   assert.equal(request.params.clickCount,1);
  }
  assert.equal(result.details.execution.outcome,'unknown');
 }

 current=await fresh('Editor');let nativeCalls=0;
 backend.act=async()=>{
  nativeCalls++;
  if(nativeCalls===1)return {outcome:'worked',performed:{delivery:'hid'}};
  throw new NativeActionPreflightError('Target is occluded','occluded_target');
 };
 const partial=await call(executeAct,{stateId:current.stateId,actions:[{action:'click',ref:current.ref},{action:'click',ref:current.ref}],observationMode:'semantic'});
 assert.equal(nativeCalls,2);
 assert.equal(partial.details.execution.outcome,'unknown');
 assert.equal(partial.details.execution.batchFailure.returnedPrefixActions,1);
 assert.equal(partial.details.preflight,undefined,'a local no-input receipt cannot erase an executed prefix');
 console.log('Recoverable caller errors, same-state correction and no-image Windows ref click passed (injected native backend)');
}finally{Object.assign(backend,original);await shutdownComputerUseSession();}
