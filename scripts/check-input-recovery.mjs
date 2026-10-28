import assert from 'node:assert/strict';
import {parseLookResponse} from '../src/outline.ts';
import {currentPlatformBackend as backend} from '../src/platform/index.ts';
import {executeFind,executeObserve,executeSearchUi,executeAct,shutdownComputerUseSession} from '../src/bridge.ts';

// Public-tool fault injection. No helper is launched and no desktop input is sent.
const original={...backend};
const root={kind:'window',rootRef:'recovery-root',windowRef:'recovery-root',windowId:10,pid:7,appName:'Recovery fixture',title:'Owned recovery fixture',zOrder:0,framePoints:{x:0,y:0,w:100,h:100},scaleFactor:1,isOnscreen:true,isFocused:true,isMinimized:false,isMain:true,isModal:false};
let calls=0,observations=0;
const call=(fn,params)=>fn('input-recovery',params,undefined,undefined,{cwd:process.cwd(),hasUI:false});
const dispatch=()=>({eventsDispatched:3,unreleasedKeys:[],unreleasedMouseButtons:[],recoveryRequired:false,retrySafe:false,
 inputRecovery:{schemaVersion:1,scope:'native_transaction',status:'verified',nativeOperationStopped:true,inputReplayed:false,verification:'system_input_state',operationEventsDispatched:2,releaseEventsDispatched:1,verifiedKeys:[],verifiedMouseButtons:[0],unreleasedKeys:[],unreleasedMouseButtons:[]}});
Object.assign(backend,{
 ensureReady:async()=>({lastPermissionCheckAt:Date.now()}),listApps:async()=>[{appName:root.appName,pid:7}],listRoots:async()=>[root],getFrontmost:async()=>({appName:root.appName,pid:7,windowId:10,rootRef:root.rootRef}),
 observe:async()=>{observations++;return parseLookResponse({lookId:'recovery-look-'+observations,capturedAt:Date.now()/1000,window:{windowId:10,framePoints:root.framePoints,scaleFactor:1,isModal:false},outline:{ref:'native-review',role:'button',title:'Review result',canPress:true,actions:['press'],children:[]},timings:{}});},actBatch:undefined,
});
async function observe(){
 const found=await call(executeFind,{text:root.title});
 const observed=await call(executeObserve,{root:found.details.windows[0].windowRef,mode:'semantic'});
 const search=await call(executeSearchUi,{stateId:observed.details.capture.stateId,text:'Review result',role:'button'});
 return {stateId:observed.details.capture.stateId,ref:search.details.matches[0].ref};
}
async function attempt(input,code='foreground_interrupted_after_partial_hid'){
 await shutdownComputerUseSession();calls=0;
 backend.act=async()=>{calls++;return {outcome:'unknown',performed:{delivery:'hid'},error:{code,message:'Injected interruption'},inputDispatch:input};};
 const before=await observe();const observed=observations;
 const result=await call(executeAct,{stateId:before.stateId,actions:[{action:'press',ref:before.ref},{action:'press',ref:before.ref}]});
 assert.equal(calls,1,'never replay or run the remainder after partial input');
 assert.equal(observations,observed,'a cleanup receipt cannot turn an unknown action into a successful successor');
 assert.equal(result.details.status,'dispatch_outcome_unknown');
 assert.equal(result.details.execution.outcome,'unknown');
 assert.equal(result.details.execution.effectVerification,'unverified');
 assert.equal(result.details.execution.inputDispatch.retrySafe,false);
 assert.equal(result.details.stateId,undefined);
 await assert.rejects(()=>call(executeAct,{stateId:before.stateId,actions:[{action:'press',ref:before.ref}]}));
 assert.equal(calls,1,'the pre-interruption state remains invalid');
 return result;
}
try{
 for(const code of ['foreground_interrupted_after_partial_hid','modifier_interrupted_after_partial_hid','native_input_interrupted_after_partial_hid','input_source_changed']){
  const input=dispatch();const result=await attempt(input,code);
  assert.equal(result.details.error.code,code);
  assert.equal(result.details.execution.dispatchCompletion,'returned');
  assert.equal(result.details.execution.inputDispatch.recoveryRequired,false);
  assert.deepEqual(result.details.execution.inputDispatch.inputRecovery,input.inputRecovery);
  const text=result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
  assert.match(text,/No manual desktop reset is required/);assert.match(text,/find_roots/);assert.match(text,/do not replay/i);
  await observe();
  assert.equal(calls,1,'read-only resynchronization does not replay input');
 }
 const corruptions=[
  x=>delete x.inputRecovery,x=>{x.inputRecovery.status='blocked';},x=>{x.inputRecovery.schemaVersion=2;},
  x=>{x.inputRecovery.scope='desktop';},x=>{x.inputRecovery.nativeOperationStopped=false;},
  x=>{x.inputRecovery.inputReplayed=true;},x=>{x.inputRecovery.verification='dispatch_ack';},
  x=>{x.unreleasedKeys=[59];},x=>{x.unreleasedMouseButtons=[0];},x=>{x.inputRecovery.unreleasedKeys=[59];},
  x=>{x.inputRecovery.unreleasedMouseButtons=[0];},x=>{x.inputRecovery.releaseEventsDispatched=2;},
  x=>{x.inputRecovery.operationEventsDispatched=0;},x=>{x.inputRecovery.verifiedKeys=[-1];},
  x=>{x.inputRecovery.verifiedMouseButtons=[0,0];},x=>delete x.inputRecovery.verifiedKeys,
  x=>delete x.unreleasedKeys,x=>{x.recoveryRequired=true;},
  x=>{x.retrySafe=true;},x=>delete x.retrySafe,x=>{x.eventsDispatched=0;},
  x=>{x.eventsDispatched='3';},x=>delete x.eventsDispatched,x=>{for(const key of Object.keys(x))delete x[key];},
 ];
 for(const corrupt of corruptions){
  const input=dispatch();corrupt(input);
  const result=await attempt(input);
  assert.equal(result.details.execution.inputDispatch.recoveryRequired,true,'an incomplete or contradictory receipt must retain quarantine');
  assert.equal(result.details.execution.inputDispatch.inputRecovery,undefined);
  assert.equal(result.details.execution.dispatchCompletion,'unknown');
  assert(result.content.some(c=>c.type==='text'&&c.text.includes('Keep writes quarantined')));
 }
 // Even a successful cleanup receipt cannot resolve a lost terminal response.
 await shutdownComputerUseSession();calls=0;
 backend.act=async()=>{calls++;throw Object.assign(new Error('Native response lost'),{code:'helper_transport_unknown',outcome:'unknown',command:'act',requestId:'recovery-lost',requestWriteAttempted:true,inputRecovery:dispatch().inputRecovery});};
 const before=await observe();
 const unknown=await call(executeAct,{stateId:before.stateId,actions:[{action:'press',ref:before.ref}]});
 assert.equal(unknown.details.execution.transport.outcome,'unknown');
 assert.equal(unknown.details.execution.inputDispatch,undefined);
 assert(unknown.content.some(c=>c.type==='text'&&c.text.includes('Keep writes quarantined')));
 assert.equal(calls,1);
 console.log('Owned-input recovery public-tool checks passed: 4 recovered interruptions, 24 rejected receipts/ledgers, lost-response quarantine; no replay or stale-state reuse');
}finally{Object.assign(backend,original);await shutdownComputerUseSession();}
