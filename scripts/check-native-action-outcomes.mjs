import assert from 'node:assert/strict';
import {parseLookResponse} from '../src/outline.ts';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {executeFind,executeObserve,executeSearchUi,executeAct,shutdownComputerUseSession} from '../src/bridge.ts';
import {currentPlatformBackend} from '../src/platform/index.ts';
import * as sdk from '@earendil-works/pi-coding-agent';
import {Value} from 'typebox/value';
// Controlled backend results exercise registered tools. No native helper/input.
const original={...currentPlatformBackend};
const root={kind:'window',rootRef:'native-outcome-root',windowId:71,pid:100071,appName:'Outcome fixture',title:'Owned outcome fixture',zOrder:0,framePoints:{x:0,y:0,w:100,h:100},scaleFactor:1,isOnscreen:true,isFocused:true,isMinimized:false,isMain:true,isModal:false,metadata:{interaction:{enabled:true,ownerHwnd:72,ownerEnabled:false,ownerDisabled:true,unexpected:'must not leak'}}};
const make=(ref,role,title,extra={})=>({ref,role,title,subrole:'',identifier:'',description:'',value:'',actions:[],canPress:false,canFocus:false,canSetValue:false,canScroll:false,canIncrement:false,canDecrement:false,isTextInput:false,focused:false,offscreen:false,pictureOnly:false,truncated:false,text:[],children:[],rect:{x:0,y:0,w:20,h:20},...extra});
let outcome='didnt',calls=[],value='old',presses=0,look=0,enabled=true,observations=[];
Object.assign(currentPlatformBackend,{
 ensureReady:async()=>({lastPermissionCheckAt:Date.now()}),listApps:async()=>[{appName:root.appName,pid:root.pid,isFrontmost:true}],listRoots:async()=>[root],
 getFrontmost:async()=>({appName:root.appName,pid:root.pid,windowTitle:root.title,windowId:root.windowId,rootRef:root.rootRef}),
 isBrowserApp:()=>false,isChromeFamilyApp:()=>false,
 observe:async(request)=>{observations.push(request);return parseLookResponse({lookId:'outcome-look-'+(++look),capturedAt:Date.now(),window:{windowId:root.windowId,rootRef:root.rootRef,framePoints:{x:0,y:0,w:100,h:100},scaleFactor:1,isModal:false,role:'window',subrole:''},outline:make('@w1','window',root.title,{children:[make('native-field','textbox','Field',{value,canSetValue:true,isTextInput:true,actions:['set_text']}),make('native-commit','button','Commit',{isEnabled:enabled,canPress:enabled,actions:enabled?['press']:[]})]}),timings:{captureMs:57,describeMs:3,readTextMs:0,totalMs:60}});},
 act:async(request)=>{calls.push(request);if(request.action==='setText'&&outcome==='worked')value=request.params.text;if(request.action==='press')presses++;return {outcome,performed:{grounding:'description',delivery:'ax'}};},shutdown:async()=>{},
});
const directory=await mkdtemp(path.join(os.tmpdir(),'cu-outcomes-'));
let runner;
try{
 const loaded=await sdk.discoverAndLoadExtensions([path.join(process.cwd(),'extensions/computer-use.ts')],process.cwd(),directory);
 assert.equal(loaded.errors.length,0);assert.equal(loaded.extensions.length,1);
 const models=await sdk.ModelRuntime.create({authPath:path.join(directory,'unused-auth.json'),modelsPath:null,refreshOnCreate:false,allowModelNetwork:false});
 runner=new sdk.ExtensionRunner(loaded.extensions,loaded.runtime,process.cwd(),sdk.SessionManager.inMemory(process.cwd()),new sdk.ModelRegistry(models));
 loaded.runtime.getActiveTools=()=>runner.getAllRegisteredTools().map(t=>t.definition.name);
 // Loader isolates extension modules. Bind the same public executors from the
 // controlled-backend module instance before applying the SDK tool wrappers.
 const executors={find_roots:executeFind,observe_ui:executeObserve,search_ui:executeSearchUi,act_ui:executeAct};
 for(const registered of runner.getAllRegisteredTools()){if(executors[registered.definition.name])registered.definition.execute=executors[registered.definition.name];}
 const tools=new Map(sdk.wrapRegisteredTools(runner.getAllRegisteredTools(),runner).map(t=>[t.name,t]));
 async function call(name,params){const tool=tools.get(name);assert(tool);assert(Value.Check(tool.parameters,params));return await tool.execute('outcomes',params);}
 for(const expected of ['didnt','unknown','worked']){
  outcome=expected;calls=[];value='old';presses=0;
  const found=await call('find_roots',{text:root.title});assert.equal(found.details.windows.length,1);assert.deepEqual(found.details.windows[0].interaction,{enabled:true,ownerHwnd:72,ownerEnabled:false,ownerDisabled:true});assert(found.content.some(c=>c.type==='text'&&c.text.includes('owner_disabled=72')));
  const observed=await call('observe_ui',{root:found.details.windows[0].windowRef});
  const {semanticObservationMs,imageObservationMs,observationPipelineMs,targetResolutionMs,resultBuildMs,observeRequestMs,...nativeTimings}=observed.details.observationTimings;
  for(const value of [targetResolutionMs,resultBuildMs,observeRequestMs])assert(Number.isFinite(value)&&value>=0);
  assert(observeRequestMs>=targetResolutionMs+observationPipelineMs);
  assert.deepEqual(nativeTimings,{captureMs:57,describeMs:3,readTextMs:0,totalMs:60});
  for(const duration of [semanticObservationMs,imageObservationMs,observationPipelineMs])assert(Number.isFinite(duration)&&duration>=0);
  assert(observationPipelineMs>=semanticObservationMs+imageObservationMs);
  const field=await call('search_ui',{stateId:observed.details.capture.stateId,text:'Field',role:'textbox'});
  const commit=await call('search_ui',{stateId:observed.details.capture.stateId,text:'Commit',role:'button'});
  const exact=r=>{const matches=r.details.matches.filter(m=>m.matchReason==='exact');assert.equal(matches.length,1);return matches[0].ref;};
  const result=await call('act_ui',{stateId:observed.details.capture.stateId,actions:[{action:'setText',ref:exact(field),text:'new'},{action:'press',ref:exact(commit)}]});
  assert.equal(result.details.execution.outcome,expected);
  const text=result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
  if(expected==='worked'){assert.equal(calls.length,2);assert.equal(presses,1);assert.match(text,/Attempted 2 of 2/);}
  else{assert.equal(calls.length,1);assert.equal(presses,0);assert.equal(value,'old');assert.match(text,/Attempted 1 of 2/);assert.match(text,/Remaining 1 actions were not sent/);}
  if(expected==='unknown')assert.match(text,/Do not automatically repeat/);
  if(expected==='didnt')assert.match(text,/no effect was observed/);
 }
 // Explicit semantic successor avoids image capture without relaxing input grounding.
 {
  outcome='worked';value='old';observations=[];
  const roots=await call('find_roots',{text:root.title});
  const initial=await call('observe_ui',{root:roots.details.windows[0].windowRef,mode:'semantic'});
  const matches=await call('search_ui',{stateId:initial.details.capture.stateId,text:'Field',role:'textbox'});
  const ref=matches.details.matches.find(m=>m.matchReason==='exact').ref;
  const count=calls.length;observations=[];
  const successor=await call('act_ui',{stateId:initial.details.capture.stateId,observationMode:'semantic',actions:[{action:'setText',ref,text:'semantic-successor'}]});
  assert.equal(calls.length,count+1);
  assert.equal(observations.length,1);
  assert.equal(observations[0].includeImage,false);
  assert.equal(observations[0].readText,'never');
  assert(!successor.content.some(c=>c.type==='image'));
  assert.equal(successor.details.execution.outcome,'worked');
  const fresh=await call('search_ui',{stateId:successor.details.capture.stateId,text:'Field',role:'textbox'});
  assert(fresh.details.matches.some(m=>m.matchReason==='exact'));
  assert.equal(successor.details.outline.root.children.find(n=>n.title==='Field').value,'semantic-successor');
  await assert.rejects(call('act_ui',{stateId:successor.details.capture.stateId,actions:[{action:'click',x:1,y:1}]}),/image-bearing/);
  assert.equal(calls.length,count+1,'Outline-only successor must reject image point before dispatch');
  observations=[];
  await call('act_ui',{stateId:successor.details.capture.stateId,observationMode:'fused',actions:[{action:'setText',ref:fresh.details.matches.find(m=>m.matchReason==='exact').ref,text:'fused-successor'}]});
  assert.equal(observations.length,1);assert.equal(observations[0].includeImage,true);
 }
 enabled=false;
 const disabledFound=await call('find_roots',{text:root.title});
 const disabledObserved=await call('observe_ui',{root:disabledFound.details.windows[0].windowRef});
 const disabledMatch=await call('search_ui',{stateId:disabledObserved.details.capture.stateId,text:'Commit',role:'button'});
 const disabledRef=disabledMatch.details.matches.find(m=>m.matchReason==='exact').ref;
 const beforeDisabled=calls.length;
 for(const action of ['press','click']){
  await assert.rejects(call('act_ui',{stateId:disabledObserved.details.capture.stateId,actions:[{action,ref:disabledRef}]}),/disabled; input was not sent/);
  assert.equal(calls.length,beforeDisabled);
 }
 enabled=true;
 const found=await call('find_roots',{text:root.title});
 const targetRoot=found.details.windows[0].windowRef;
 const semantic=await call('observe_ui',{root:targetRoot,mode:'semantic'});
 assert.equal(semantic.details.observationTimings.imageObservationMs,0);
 const nativeObserve=currentPlatformBackend.observe;
 const actionsBefore=calls.length;
 currentPlatformBackend.observe=async(request,options)=>{
  if(request.includeImage===true)throw Error('Controlled image-stage failure');
  return await nativeObserve(request,options);
 };
 const degraded=await call('observe_ui',{root:targetRoot,mode:'visual'});
 assert.equal(degraded.details.observation.status,'semantic_only');
 assert.match(degraded.details.observation.imageError,/Controlled image-stage failure/);
 assert.equal(degraded.details.observation.nativeCompletion,'unconfirmed');
 assert(degraded.details.outline.root,'Image failure must retain real semantic outline');
 assert(!degraded.content.some(c=>c.type==='image'));
 const phase=degraded.details.observationTimings;
 assert(phase.observationPipelineMs>=phase.semanticObservationMs+phase.imageObservationMs);
 assert.equal(calls.length,actionsBefore,'Observation failure must not dispatch input');
 currentPlatformBackend.ensureReady=async()=>({lastPermissionCheckAt:Date.now(),helperDiagnostics:{protocolVersion:4,pid:1,optionalImageFailure:true}});
 let combinedCalls=0;
 currentPlatformBackend.observe=async(request,options)=>{
  combinedCalls++;
  assert.equal(request.allowImageFailure,true);
  const look=await nativeObserve(request,options);
  look.imageError='Confirmed native pixel capture failure';
  return look;
 };
 const combined=await call('observe_ui',{root:targetRoot,mode:'visual'});
 assert.equal(combinedCalls,1,'Capable helper must extract only one fresh outline');
 assert.equal(combined.details.observation.status,'semantic_only');
 assert.equal(combined.details.observation.nativeCompletion,'completed');
 assert.equal(combined.details.observationTimings.semanticObservationMs,0);
 assert(combined.details.outline.root);
 assert.equal(calls.length,actionsBefore);
 for(const message of ['target_not_found: exact HWND vanished','Helper transport timeout: completion unknown']){
  let attempted=0;
  currentPlatformBackend.observe=async()=>{attempted++;throw Error(message);};
  await assert.rejects(()=>call('observe_ui',{root:targetRoot,mode:'visual'}),message.includes('target_not_found')?/target_not_found/:/completion unknown/);
  assert.equal(attempted,1,'Single-pass observation error must not start a fallback request');
  assert.equal(calls.length,actionsBefore,'Observation uncertainty must not send input');
 }
 currentPlatformBackend.observe=nativeObserve;
 console.log('Registered native action outcome integration passed (3 controlled outcomes; no native input)');
}finally{
 await shutdownComputerUseSession();
 Object.assign(currentPlatformBackend,original);
 await rm(directory,{recursive:true,force:true});
}

// Provider failures remain explicit without fabricating a child action target.
const partialLook = parseLookResponse({lookId: 'provider-timeout', capturedAt: 1,
    window: {}, outline: {ref: '@w1', role: 'Window', truncated: true, children: []},
    uiaDiagnostics: {status: 'incomplete', reason: 'provider_error', error: 'x'.repeat(2000)}});
assert.equal(partialLook.uiaDiagnostics.status, 'incomplete');
assert.equal(partialLook.uiaDiagnostics.error.length, 1024);
assert.equal(partialLook.outline.truncated, true);
assert.equal(partialLook.outline.children.length, 0);
