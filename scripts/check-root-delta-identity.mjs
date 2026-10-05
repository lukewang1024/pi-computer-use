import assert from 'node:assert/strict';
import {executeFind,executeObserve,executeAct,shutdownComputerUseSession} from '../src/bridge.ts';
import {currentPlatformBackend as backend} from '../src/platform/index.ts';
import {parseLookResponse} from '../src/outline.ts';
const original={...backend};
const makeRoot=(windowId,rootRef,title,extra={})=>({kind:'window',windowId,rootRef,windowRef:rootRef,pid:100029,appName:'Root pin fixture',title,zOrder:5,framePoints:{x:0,y:0,w:100,h:100},scaleFactor:1,isOnscreen:true,isFocused:false,isMain:true,isMinimized:false,isModal:false,...extra});
const owned=makeRoot(71,'native-owned','Owned root pin fixture');
const other=makeRoot(72,'native-other','Another document dialog',{kind:'sheet',zOrder:0,isFocused:true,isModal:true});
let roots=[owned,other],inputs=[],looks=0;const lookRoots=new Map();
const node=(ref,role,title,extra={})=>({ref,role,title,subrole:'',identifier:'',description:'',value:'',actions:[],canPress:false,canFocus:false,canSetValue:false,canScroll:false,canIncrement:false,canDecrement:false,isTextInput:false,focused:false,offscreen:false,pictureOnly:false,truncated:false,text:[],children:[],rect:{x:0,y:0,w:20,h:20},...extra});
Object.assign(backend,{
 name:"macos",
 ensureReady:async()=>({lastPermissionCheckAt:Date.now()}),
 listApps:async()=>[{appName:owned.appName,pid:owned.pid,isFrontmost:true}],listRoots:async()=>roots,
 getFrontmost:async()=>({appName:other.appName,pid:other.pid,windowId:other.windowId,rootRef:other.rootRef}),
 isBrowserApp:()=>false,isChromeFamilyApp:()=>false,actBatch:undefined,
 observe:async request=>{
  const root=roots.find(r=>r.rootRef===request.target.windowRef)??roots.find(r=>r.windowId===request.target.windowId);assert(root,'Observation must address an existing exact root');
  const lookId='root-pin-look-'+(++looks);lookRoots.set(lookId,root);return parseLookResponse({lookId,capturedAt:Date.now(),window:{windowId:root.windowId,rootRef:root.rootRef,framePoints:root.framePoints,scaleFactor:1,isModal:root.isModal,role:root.kind,subrole:''},outline:node(root.rootRef,'window',root.title,{children:[node(root.rootRef+'-button','AXComboBox','Font Size',{isTextInput:true,canFocus:true,actions:['AXConfirm']})]}),timings:{}});
 },
 act:async request=>{inputs.push(request);return {outcome:'unknown',performed:{grounding:'description',delivery:'ax',nativeAction:'AXConfirm'}};},shutdown:async()=>{},
});
const call=(fn,params)=>fn('root-pin-regression',params,undefined,undefined,{cwd:process.cwd(),hasUI:false});
async function observeOwned(){const found=await call(executeFind,{text:owned.title});const target=found.details.windows.filter(r=>r.windowId===owned.windowId);assert.equal(target.length,1);return await call(executeObserve,{root:target[0].windowRef,mode:'semantic'});}
const button=d=>{const children=d.details.outline.root.children;assert.equal(children.length,1);return children[0].ref;};
try{
 for(const changed of ['same-window-new-ax-ref','different-window-same-title','missing']){
  await shutdownComputerUseSession();roots=[owned];inputs=[];
  backend.act=async request=>{inputs.push(request);return {outcome:'worked',performed:{delivery:'ax'},rootDelta:[{change:'appeared',kind:'window',ref:'native-popup-old',windowId:81,title:'Header',pid:owned.pid}]};};
  const observed=await observeOwned();
  const acted=await call(executeAct,{stateId:observed.details.capture.stateId,actions:[{action:'commit',ref:button(observed)}]});
  const delta=acted.details.execution.rootDelta.find(d=>d.change==='appeared');
  assert.equal(delta.windowId,81);assert.match(delta.ref,/^@r\d+$/);
  roots=changed==='missing'?[owned]:[owned,makeRoot(81,'parent-sheet','Header',{kind:'sheet',isModal:true}),makeRoot(changed==='different-window-same-title'?82:81,'native-popup-new','Header')];
  const inputCount=inputs.length;
  if(changed==='same-window-new-ax-ref'){
   const popup=await call(executeObserve,{root:delta.ref,mode:'semantic'});
   assert.equal(popup.details.target.windowId,81);assert.equal(popup.details.target.nativeWindowRef,'native-popup-new');
   roots=[owned,makeRoot(82,'native-popup-new','Header')];
   await assert.rejects(()=>call(executeObserve,{root:delta.ref,mode:'semantic'}),/stale/);
  }else{
   await assert.rejects(()=>call(executeObserve,{root:delta.ref,mode:'semantic'}),/stale/);
  }
  assert.equal(inputs.length,inputCount,'Resolving a popup must not dispatch input');
 }
 // Older helpers without an id must also reject a same-title replacement.
 await shutdownComputerUseSession();roots=[owned];inputs=[];
 backend.act=async request=>{inputs.push(request);return {outcome:'worked',performed:{delivery:'ax'},rootDelta:[{change:'appeared',kind:'window',ref:'native-popup-old',title:'Header',pid:owned.pid}]};};
 const observed=await observeOwned();
 const acted=await call(executeAct,{stateId:observed.details.capture.stateId,actions:[{action:'commit',ref:button(observed)}]});
 roots=[owned,makeRoot(82,'native-popup-new','Header')];
 await assert.rejects(()=>call(executeObserve,{root:acted.details.execution.rootDelta[0].ref,mode:'semantic'}),/stale/);
 assert.equal(inputs.length,1);
 console.log('Public root delta identity passed: same-window AX churn, replacement, disappearance, legacy exact ref; mocked backend only');
}finally{Object.assign(backend,original);await shutdownComputerUseSession();}
