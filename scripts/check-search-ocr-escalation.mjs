import assert from 'node:assert/strict';
import {parseLookResponse} from '../src/outline.ts';
import {currentPlatformBackend as backend} from '../src/platform/index.ts';
import {executeFind,executeObserve,executeSearchUi,shutdownComputerUseSession} from '../src/bridge.ts';

// Controlled observations count captures; no native helper or input is used.
const root={kind:'window',rootRef:'search-root',windowId:71,pid:100071,appName:'Search fixture',title:'Owned search fixture',zOrder:0,framePoints:{x:0,y:0,w:100,h:100},scaleFactor:1,isOnscreen:true,isFocused:true,isMinimized:false,isMain:true,isModal:false};
const requests=[];
const overrides={
 ensureReady:async()=>({lastPermissionCheckAt:Date.now()}),listApps:async()=>[{appName:root.appName,pid:root.pid}],listRoots:async()=>[root],
 getFrontmost:async()=>({appName:root.appName,pid:root.pid,windowId:root.windowId,rootRef:root.rootRef}),isBrowserApp:()=>false,isChromeFamilyApp:()=>false,
 observe:async(request)=>{
  requests.push(request);const ocr=request.readText==='always';
  return parseLookResponse({lookId:'search-look-'+requests.length,capturedAt:Date.now(),window:{windowId:root.windowId,rootRef:root.rootRef,framePoints:root.framePoints,scaleFactor:1,isModal:false},
   outline:{ref:'window',role:'AXWindow',title:root.title,children:[{ref:'pane',role:'AXGroup',title:'Document Pane',children:[]},{ref:'note',role:'AXStaticText',title:'Cached note',children:[]},...(ocr?[{ref:'pixels',role:'AXStaticText',title:'Only pixels',pictureOnly:true,children:[]}]:[])]},
   readText:{requested:request.readText||'auto',executed:ocr},
   image:ocr?{jpegBase64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT1sAAAAASUVORK5CYII=',mimeType:'image/png',width:1,height:1}:undefined,timings:{}});
 },act:async()=>{throw Error('Search must not dispatch input');},
};
const original=Object.fromEntries(Object.keys(overrides).map(key=>[key,backend[key]]));Object.assign(backend,overrides);
const call=(fn,params)=>fn('search-regression',params,undefined,undefined,{cwd:process.cwd(),hasUI:false});
try{
 const roots=await call(executeFind,{text:root.title});const rootRef=roots.details.windows[0].windowRef;
 const observed=await call(executeObserve,{root:rootRef,mode:'fused'});const stateId=observed.details.capture.stateId;const initial=requests.length;
 for(const query of [{text:'Document Pane'},{text:'Cached note'},{role:'Missing role'}]){
  const result=await call(executeSearchUi,{stateId,...query});assert.equal(result.details.stateId,stateId);assert.equal(requests.length,initial,'Cached structural/text matches and role-only misses must not capture pixels');
  assert.equal(result.details.matches.length,query.role?0:1);
 }
 const pixels=await call(executeSearchUi,{stateId,text:'Only pixels'});assert.equal(requests.length,initial+1,'Unmatched text must retain the OCR fallback');
 assert.equal(pixels.details.matches.length,1);assert.equal(pixels.details.matches[0].label,'Only pixels');
 const next=pixels.details.stateId;await call(executeSearchUi,{stateId:next,text:'Only pixels'});await call(executeSearchUi,{stateId:next,text:'Still absent'});
 assert.equal(requests.length,initial+1,'One completed OCR look must not be captured repeatedly');
 console.log('Search capture regression passed: cached matches/role misses stay semantic; unmatched text retains bounded OCR');
}finally{Object.assign(backend,original);await shutdownComputerUseSession();}
