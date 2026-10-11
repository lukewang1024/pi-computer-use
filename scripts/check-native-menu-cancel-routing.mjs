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
  const lookId='root-pin-look-'+(++looks);lookRoots.set(lookId,root);return parseLookResponse({lookId,capturedAt:Date.now(),window:{windowId:root.windowId,rootRef:root.rootRef,framePoints:root.framePoints,scaleFactor:1,isModal:root.isModal,role:root.kind,subrole:''},outline:node(root.rootRef,'window',root.title,{children:[node(root.rootRef+'-button','AXMenu','Visible owned menu',{isTextInput:true,canFocus:true,canPress:true,actions:['AXCancel'],isEnabled:nodeEnabled})]}),timings:{}});
 },
 act:async request=>{inputs.push(request);return {outcome:'unknown',performed:{grounding:'description',delivery:'ax',nativeAction:'AXCancel'}};},shutdown:async()=>{},
});
const call=(fn,params)=>fn('root-pin-regression',params,undefined,undefined,{cwd:process.cwd(),hasUI:false});
async function observeOwned(){const found=await call(executeFind,{text:owned.title});const target=found.details.windows.filter(r=>r.windowId===owned.windowId);assert.equal(target.length,1);return await call(executeObserve,{root:target[0].windowRef,mode:'semantic'});}
const button=d=>{const children=d.details.outline.root.children;assert.equal(children.length,1);return children[0].ref;};
try {
 roots=[owned,other];inputs=[];
 const observed=await observeOwned();
 const result=await call(executeAct,{stateId:observed.details.capture.stateId,actions:[{action:'cancel',ref:button(observed)},{action:'cancel',ref:button(observed)}]});
 assert.equal(inputs.length,1,'Unknown cancellation stops the remaining batch');
 assert.equal(inputs[0].action,'cancel');assert.equal(inputs[0].target.ref,owned.rootRef+'-button');
 assert.equal(lookRoots.get(inputs[0].lookId).windowId,71,'Same-PID foreground sibling must not replace the menu root');
 assert.equal(result.details.execution.outcome,'unknown');
 for(const changed of [{...owned,windowId:73},{...owned,rootRef:'native-replacement',windowRef:'native-replacement'}]){
  roots=[owned,other];inputs=[];const fresh=await observeOwned();roots=[changed,other];
  await assert.rejects(()=>call(executeAct,{stateId:fresh.details.capture.stateId,actions:[{action:'cancel',ref:button(fresh)}]}),/different window|no longer available|no longer exists|not found/i);
  assert.equal(inputs.length,0);
 }
 roots=[owned,other];inputs=[];const fresh=await observeOwned();
 await assert.rejects(()=>call(executeAct,{stateId:fresh.details.capture.stateId,actions:[{action:'cancel',ref:button(fresh)},{action:'cancel',ref:'@e999999'}]}),/reference|ref|outline/i);
 assert.equal(inputs.length,0,'Invalid later reference rejects the entire sequence before dispatch');
 for(const coordinates of [{x:1,y:2},{x:1},{y:2}]){
  await assert.rejects(()=>call(executeAct,{stateId:fresh.details.capture.stateId,actions:[{action:'cancel',ref:button(fresh),...coordinates}]}),/native element ref|both x and y|coordinate/i);
  assert.equal(inputs.length,0,'Coordinates must not become a cancellation fallback');
 }
 const originalAct=backend.act;
 backend.act=async request=>{inputs.push(request);throw Object.assign(new Error('Foreground unavailable'),{code:'foreground_required'});};
 try{
  await assert.rejects(()=>call(executeAct,{stateId:fresh.details.capture.stateId,actions:[{action:'cancel',ref:button(fresh)}]}),/Foreground unavailable/);
  assert.equal(inputs.length,1,'Foreground failure must not trigger a second native cancellation');
 }finally{backend.act=originalAct;inputs=[];}
 nodeEnabled=false;const disabled=await observeOwned();
 await assert.rejects(()=>call(executeAct,{stateId:disabled.details.capture.stateId,actions:[{action:'cancel',ref:button(disabled)}]}),/disabled/);
 assert.equal(inputs.length,0);
 console.log('Public cancel routing passed: exact root, same-PID sibling, remapped root, invalid batch ref, disabled menu, unknown stops batch; mocked backend only');
}finally{Object.assign(backend,original);await shutdownComputerUseSession();}
