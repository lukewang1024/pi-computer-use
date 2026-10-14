import assert from 'node:assert/strict';
import {executeFind,executeObserve,executeAct,shutdownComputerUseSession} from '../src/bridge.ts';
import {currentPlatformBackend as backend} from '../src/platform/index.ts';
import {parseLookResponse} from '../src/outline.ts';
const original={...backend}, pid=100029, inputs=[];
const root=(windowId,rootRef,kind='window',rootPid=pid)=>({kind,windowId,rootRef,windowRef:rootRef,pid:rootPid,appName:'Windows delta fixture',title:kind==='window'?'Owned document':'Same title popup',zOrder:1,framePoints:{x:0,y:0,w:100,h:100},scaleFactor:1,isOnscreen:true,isFocused:true,isMain:true,isMinimized:false,isModal:kind!=='window'});
const owned=root(70,'native-owned');let roots=[owned], looks=0;
const node=(ref,role,title,extra={})=>({ref,role,subrole:'',title,value:'',description:'',text:[],identifier:'',actions:[],rect:{x:0,y:0,w:100,h:100},children:[],...extra});
Object.assign(backend,{
 name:'windows',ensureReady:async()=>({lastPermissionCheckAt:Date.now()}),
 listApps:async()=>[{appName:owned.appName,pid,isFrontmost:true}],
 listRoots:async query=>roots.filter(r=>query.pid===undefined||r.pid===query.pid),
 getFrontmost:async()=>({appName:owned.appName,pid,windowId:70,rootRef:owned.rootRef}),
 isBrowserApp:()=>false,isChromeFamilyApp:()=>false,actBatch:undefined,
 observe:async request=>{
  const target=roots.find(r=>r.pid===request.target.pid&&r.windowId===request.target.windowId);assert(target);
  return parseLookResponse({lookId:'windows-delta-look-'+(++looks),capturedAt:Date.now(),window:{windowId:target.windowId,rootRef:target.rootRef,framePoints:target.framePoints,scaleFactor:1,isModal:target.isModal,role:target.kind,subrole:''},outline:node(target.rootRef,'Window',target.title,{children:[node(target.rootRef+'-button','button','Open popup',{actions:['AXPress'],canPress:true,isEnabled:true})]}),timings:{}});
 },shutdown:async()=>{},
});
const call=(fn,params)=>fn('windows-root-delta',params,undefined,undefined,{cwd:process.cwd(),hasUI:false});
try{
 for(const kind of ['dialog','popover','menu'])for(const returnedRef of ['temporary-snapshot-ref',owned.rootRef]){
  await shutdownComputerUseSession();roots=[owned];inputs.length=0;
  backend.act=async request=>{inputs.push(request);roots=[owned,root(81,'native-live-popup',kind)];return {outcome:'worked',performed:{delivery:'ax'},rootDelta:[{change:'appeared',kind,ref:returnedRef,windowId:81,title:'Same title popup',pid}]};};
  const found=await call(executeFind,{text:owned.title});
  const observed=await call(executeObserve,{root:found.details.windows[0].windowRef,mode:'semantic'});
  const acted=await call(executeAct,{stateId:observed.details.capture.stateId,actions:[{action:'press',ref:observed.details.outline.root.children[0].ref}]});
  const delta=acted.details.execution.rootDelta.find(d=>d.change==='appeared');assert(delta);
  roots=[owned,root(81,'native-remapped-popup',kind),root(82,'native-decoy',kind)];
  const popup=await call(executeObserve,{root:delta.ref,mode:'semantic'});
  assert.equal(popup.details.target.windowId,81);assert.equal(popup.details.target.nativeWindowRef,'native-remapped-popup');
  for(const replacement of [root(82,'native-same-title',kind),root(81,'native-other-pid',kind,pid+1),null]){
   roots=[owned,...(replacement?[replacement]:[])];
   await assert.rejects(()=>call(executeObserve,{root:delta.ref,mode:'semantic'}),/stale/);
  }
  assert.equal(inputs.length,1,'Root discovery must neither replay input nor follow a replacement');
 }
 console.log('Windows root deltas retain exact HWND across native ref remaps; same-title/PID replacements and closed roots refused without input.');
}finally{await shutdownComputerUseSession();Object.assign(backend,original);}
