// Real Doubao sequence: action delta -> popup read -> full root enumeration.
import assert from 'node:assert/strict';
import {parseLookResponse} from '../src/outline.ts';
import {currentPlatformBackend as backend} from '../src/platform/index.ts';
import {executeFind,executeObserve,executeAct,shutdownComputerUseSession} from '../src/bridge.ts';
const original={...backend};
const root={kind:'window',rootRef:'source',windowRef:'source',windowId:10,pid:7,appName:'Fixture',title:'Owned fixture',zOrder:0,framePoints:{x:0,y:0,w:100,h:100},scaleFactor:1,isOnscreen:true,isFocused:true,isMinimized:false,isMain:true,isModal:false};
const popup={...root,rootRef:'popup',windowRef:'popup',windowId:11,title:'',isMain:false};
const otherPid={...popup,pid:8,rootRef:'foreign',windowRef:'foreign'};
const otherWindow={...popup,windowId:12,rootRef:'other-window',windowRef:'other-window'};
const call=(fn,params)=>fn('popup-identity',params,undefined,undefined,{cwd:process.cwd(),hasUI:false});
let dispatched=false,dispatches=0;
Object.assign(backend,{name:'windows',ensureReady:async()=>({lastPermissionCheckAt:Date.now()}),listApps:async()=>[{appName:'Fixture',pid:7}],listRoots:async()=>dispatched?[{...root,isFocused:false},popup,otherPid,otherWindow]:[root],getFrontmost:async()=>({appName:'Fixture',pid:7,windowId:dispatched?11:10,rootRef:dispatched?'popup':'source'}),
 observe:async request=>{
  if(dispatched&&request.target.windowId===10)throw Error('Source obscured');
  const window=dispatched?popup:root;
  return parseLookResponse({lookId:'look-'+window.windowId,capturedAt:Date.now()/1000,window:{windowId:window.windowId,framePoints:window.framePoints,scaleFactor:1,isModal:false},outline:{ref:'button-'+window.windowId,role:'button',title:dispatched?'Save as':'More',canPress:true,actions:['press'],children:[]},timings:{}});
 },act:async()=>{dispatched=true;dispatches++;return {outcome:'unknown',performed:{delivery:'ax'},rootDelta:[{change:'appeared',kind:'window',pid:7,windowId:11,ref:'popup',title:''},{change:'focused',kind:'window',pid:7,windowId:11,ref:'popup',title:''}]};},actBatch:undefined});
try {
 const initial=await call(executeFind,{text:'Owned fixture'});
 const observed=await call(executeObserve,{root:initial.details.windows[0].windowRef,mode:'semantic'});
 const result=await call(executeAct,{stateId:observed.details.capture.stateId,observationMode:'semantic',actions:[{action:'press',ref:observed.details.outline.root.ref}]});
 const popupRef=result.details.nextObservation.root;
 await call(executeObserve,{root:popupRef,mode:'semantic'});
 const found=await call(executeFind,{});
 const enumerated=found.details.windows.find(window=>window.windowId===11&&window.pid===7);
 assert.notEqual(found.details.windows.find(window=>window.windowId===11&&window.pid===8).windowRef,popupRef,'different PID must remain distinct');
 assert.notEqual(found.details.windows.find(window=>window.windowId===12&&window.pid===7).windowRef,popupRef,'different HWND must remain distinct');
 assert.equal(enumerated.windowRef,popupRef,'same Windows HWND/PID must retain its delta-created model root across discovery');
 const reread=await call(executeObserve,{root:popupRef,mode:'semantic'});
 assert.equal(reread.details.target.windowId,11);
 assert.equal(dispatches,1,'identity reconciliation must not dispatch more input');
 console.log('Popup HWND identity survives explicit reads and root enumeration');
}finally{Object.assign(backend,original);await shutdownComputerUseSession();}
