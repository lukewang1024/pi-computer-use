import assert from 'node:assert/strict';
import {executeFind,executeObserve,executeAct,executeInspectUi,executeSearchUi,shutdownComputerUseSession} from '../src/bridge.ts';
import {currentPlatformBackend as backend} from '../src/platform/index.ts';
import {parseLookResponse} from '../src/outline.ts';
const original={...backend};
const makeRoot=(windowId,rootRef,title,extra={})=>({kind:'window',windowId,rootRef,windowRef:rootRef,pid:100029,appName:'Root pin fixture',title,zOrder:5,framePoints:{x:0,y:0,w:100,h:100},scaleFactor:1,isOnscreen:true,isFocused:false,isMain:true,isMinimized:false,isModal:false,...extra});
const owned=makeRoot(71,'native-owned','Owned root pin fixture');
const other=makeRoot(72,'native-other','Another document dialog',{kind:'sheet',zOrder:0,isFocused:true,isModal:true});
let roots=[owned,other],inputs=[],looks=0,nodeEnabled;const lookRoots=new Map();
const node=(ref,role,title,extra={})=>({ref,role,title,subrole:'',identifier:'',description:'',value:'',actions:[],canPress:false,canFocus:false,canSetValue:false,canScroll:false,canIncrement:false,canDecrement:false,isTextInput:false,focused:false,offscreen:false,pictureOnly:false,truncated:false,text:[],children:[],rect:{x:0,y:0,w:20,h:20},...extra});
Object.assign(backend,{
 name:"macos",
 ensureReady:async()=>({lastPermissionCheckAt:Date.now()}),
 listApps:async()=>[{appName:owned.appName,pid:owned.pid,isFrontmost:true}],listRoots:async()=>roots,
 getFrontmost:async()=>({appName:other.appName,pid:other.pid,windowId:other.windowId,rootRef:other.rootRef}),
 isBrowserApp:()=>false,isChromeFamilyApp:()=>false,actBatch:undefined,
 observe:async request=>{
  const root=roots.find(r=>r.rootRef===request.target.windowRef)??roots.find(r=>r.windowId===request.target.windowId);assert(root,'Observation must address an existing exact root');
  const lookId='root-pin-look-'+(++looks);lookRoots.set(lookId,root);return parseLookResponse({lookId,capturedAt:Date.now(),window:{windowId:root.windowId,rootRef:root.rootRef,framePoints:root.framePoints,scaleFactor:1,isModal:root.isModal,role:root.kind,subrole:''},outline:node(root.rootRef,'window',root.title,{children:[node(root.rootRef+'-button','AXComboBox','Font Size',{isTextInput:true,canFocus:true,canPress:true,actions:['AXConfirm','AXPress'],isEnabled:nodeEnabled})]}),timings:{}});
 },
 act:async request=>{inputs.push(request);return {outcome:'unknown',performed:{grounding:'description',delivery:'ax',nativeAction:request.action==='invoke'?'AXPress':'AXConfirm'}};},shutdown:async()=>{},
});
const call=(fn,params)=>fn('root-pin-regression',params,undefined,undefined,{cwd:process.cwd(),hasUI:false});
async function observeOwned(){const found=await call(executeFind,{text:owned.title});const target=found.details.windows.filter(r=>r.windowId===owned.windowId);assert.equal(target.length,1);return await call(executeObserve,{root:target[0].windowRef,mode:'semantic'});}
const button=d=>{const children=d.details.outline.root.children;assert.equal(children.length,1);return children[0].ref;};
try{
 for(const focused of [false,true]){
  roots=[{...owned,isFocused:focused},other];inputs=[];
  const observed=await observeOwned();assert.equal(observed.details.target.windowId,71);
  const acted=await call(executeAct,{stateId:observed.details.capture.stateId,actions:[{action:'commit',ref:button(observed)}]});
  assert.equal(inputs.length,1);assert.equal(inputs[0].action,'commit');assert.equal(acted.details.execution.outcome,'unknown');assert.equal(lookRoots.get(inputs[0].lookId).windowId,71,'Native action must retain the observed look root');
  assert.equal(inputs[0].target.ref,owned.rootRef+'-button');assert.equal(acted.details.target.windowId,71);assert.equal(acted.details.target.nativeWindowRef,owned.rootRef);
 }
 // Rootless observation may discover the foreground dialog; explicit discovery
 // then supplies its own state and refs for a deliberate dialog action.
 roots=[owned,other];inputs=[];
 const foreground=await call(executeObserve,{mode:'semantic'});assert.equal(foreground.details.target.windowId,72);
 const modalAction=await call(executeAct,{stateId:foreground.details.capture.stateId,actions:[{action:'commit',ref:button(foreground)}]});
 assert.equal(inputs.length,1);assert.equal(lookRoots.get(inputs[0].lookId).windowId,72);assert.equal(modalAction.details.target.windowId,72);
 for(const changed of [{...owned,windowId:73},{...owned,rootRef:'native-replacement',windowRef:'native-replacement'}]){
  roots=[owned,other];inputs=[];const observed=await observeOwned();roots=[changed,other];
  await assert.rejects(()=>call(executeAct,{stateId:observed.details.capture.stateId,actions:[{action:'commit',ref:button(observed)}]}),/different window|no longer available|no longer exists|not found/i);
  assert.equal(inputs.length,0,'Remapped exact root must reject before dispatch');
 }
 roots=[owned,other];inputs=[];
 const semantic=await observeOwned();
 const focus=await call(executeAct,{stateId:semantic.details.capture.stateId,actions:[{action:'press',ref:button(semantic)}]});
 assert.equal(inputs.length,1);assert.equal(inputs[0].params.nativeFocusOnly,true);assert.equal(inputs[0].target.ref,owned.rootRef+'-button');
 assert.equal(focus.details.execution.outcome,'unknown','Unconfirmed native focus must not become a pointer replay');
 roots=[owned,other];inputs=[];const fresh=await observeOwned();
 await assert.rejects(()=>call(executeAct,{stateId:fresh.details.capture.stateId,actions:[{action:'commit',ref:'@e999999'}]}),/reference|ref|outline/i);assert.equal(inputs.length,0);
 for(const focused of [false,true]){
  roots=[{...owned,isFocused:focused},other];inputs=[];
  const observed=await observeOwned();
  const acted=await call(executeAct,{stateId:observed.details.capture.stateId,actions:[{action:'invoke',ref:button(observed)},{action:'commit',ref:button(observed)}]});
  assert.equal(inputs.length,1,'Unknown Invoke must stop the remaining batch without replay');
  assert.equal(inputs[0].action,'invoke');assert.equal(acted.details.execution.outcome,'unknown');
  assert.equal(inputs[0].target.ref,owned.rootRef+'-button');assert.equal(lookRoots.get(inputs[0].lookId).windowId,71);
 }
 for(const changed of [{...owned,windowId:73},{...owned,rootRef:'native-replacement',windowRef:'native-replacement'}]){
  roots=[owned,other];inputs=[];const observed=await observeOwned();roots=[changed,other];
  await assert.rejects(()=>call(executeAct,{stateId:observed.details.capture.stateId,actions:[{action:'invoke',ref:button(observed)}]}),/different window|no longer available|no longer exists|not found/i);
  assert.equal(inputs.length,0,'Invoke on a remapped root must reject before dispatch');
 }
 roots=[owned,other];inputs=[];const invokeFresh=await observeOwned();
 await assert.rejects(()=>call(executeAct,{stateId:invokeFresh.details.capture.stateId,actions:[{action:'commit',ref:button(invokeFresh)},{action:'invoke',ref:'@e999999'}]}),/reference|ref|outline/i);
 assert.equal(inputs.length,0,'Invalid later Invoke rejects the entire batch before its first action');
 roots=[owned,other];inputs=[];nodeEnabled=false;
 const disabled=await observeOwned();
 assert(disabled.content.some(c=>c.type==='text'&&c.text.includes('disabled')),'Disabled state must appear in the model-facing outline');
 const inspected=await call(executeInspectUi,{stateId:disabled.details.capture.stateId,ref:button(disabled)});
 assert.equal(inspected.details.target.isEnabled,false);
 const searched=await call(executeSearchUi,{stateId:disabled.details.capture.stateId,text:'Font Size',capability:'press'});
 assert.equal(searched.details.matches[0].isEnabled,false);
 assert(searched.content.some(c=>c.type==='text'&&c.text.includes('[disabled]')),'Search must disclose unavailable controls while retaining declared capability');
 assert(inspected.content.some(c=>c.type==='text'&&c.text.includes('disabled')),'Inspect must expose disabled state without a second action');
 for(const action of ['invoke','commit']){
  await assert.rejects(()=>call(executeAct,{stateId:disabled.details.capture.stateId,actions:[{action,ref:button(disabled)}]}),/disabled/);
  assert.equal(inputs.length,0,'An observed disabled target must reject before native dispatch');
 }
 nodeEnabled=undefined;
 console.log('Public native commit routing passed: exact modal/window, unknown outcome without replay, two remaps and stale ref; mocked backend only');
}finally{Object.assign(backend,original);await shutdownComputerUseSession();}
