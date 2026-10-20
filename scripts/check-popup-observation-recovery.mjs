// Public bridge regression: popup recovery must be an explicit read, never input replay.
import assert from 'node:assert/strict';
import {parseLookResponse} from '../src/outline.ts';
import {currentPlatformBackend as backend} from '../src/platform/index.ts';
import {executeFind,executeObserve,executeAct,shutdownComputerUseSession} from '../src/bridge.ts';
const original={...backend};
const root={kind:'window',rootRef:'source',windowRef:'source',windowId:10,pid:7,appName:'Fixture',title:'Owned fixture',zOrder:0,framePoints:{x:0,y:0,w:100,h:100},scaleFactor:1,isOnscreen:true,isFocused:true,isMinimized:false,isMain:true,isModal:false};
const popup={...root,rootRef:'popup',windowRef:'popup',windowId:11,title:'',isMain:false};
const call=(fn,params)=>fn('popup-recovery',params,undefined,undefined,{cwd:process.cwd(),hasUI:false});
async function scenario(options={}) {
 let dispatched=false,dispatches=0,postCaptures=0;
 const delta={kind:'window',pid:options.wrongPid?8:7,ref:'popup',windowId:11,title:''};
 Object.assign(backend,{name:options.otherPlatform?'linux':'windows',ensureReady:async()=>({lastPermissionCheckAt:Date.now()}),listApps:async()=>[{appName:'Fixture',pid:7}],
  listRoots:async()=>{
   if(!dispatched)return [root];
   if(options.probeError)throw Error('Identity unavailable');
   return [{...root,isFocused:false},{...popup,windowId:options.replaced?12:11,isFocused:!options.unfocused,isOnscreen:!options.hidden}];
  },getFrontmost:async()=>({appName:'Fixture',pid:7,windowId:10,rootRef:'source'}),
  observe:async()=>{
   if(dispatched){postCaptures++;throw Error('Source capture has no useful pixels');}
   return parseLookResponse({lookId:'source-look',capturedAt:Date.now()/1000,window:{windowId:10,framePoints:root.framePoints,scaleFactor:1,isModal:false},outline:{ref:'open',role:'button',title:'More',canPress:true,actions:['press'],children:[]},timings:{}});
  },act:async()=>{
   dispatched=true;dispatches++;
   if(options.transportUnknown)throw Object.assign(Error('Response lost'),{code:'helper_transport_unknown',outcome:'unknown',command:'act',requestId:'request',requestWriteAttempted:true});
   return {outcome:'unknown',performed:{delivery:'ax'},rootDelta:[{...delta,change:options.preexisting?'focused':'appeared'},{...delta,change:'focused'},...(options.ambiguous?[{...delta,change:'appeared',ref:'popup2',windowId:12},{...delta,change:'focused',ref:'popup2',windowId:12}]:[])]};
  },actBatch:undefined});
 try {
  const found=await call(executeFind,{text:'Owned fixture'});
  const observed=await call(executeObserve,{root:found.details.windows[0].windowRef,mode:'semantic'});
  const params={stateId:observed.details.capture.stateId,observationMode:'semantic',actions:[{action:'press',ref:observed.details.outline.root.ref}]};
  const result=await call(executeAct,params);
  assert.equal(dispatches,1);assert.equal(result.details.capture,undefined);assert.equal(result.details.outline,undefined);
  assert.equal(result.details.execution.outcome,'unknown','popup presence must not verify the input');
  if(Object.keys(options).length===0){
   const next=result.details.nextObservation;
   assert.equal(next.tool,'observe_ui');assert.equal(next.readOnly,true);assert.equal(next.windowId,11);assert.equal(next.pid,7);assert.equal(next.mode,'pixels');assert.match(next.root,/^@r\d+$/);
   assert.match(result.content[0].text,/Do not replay input/);
   assert.equal(postCaptures,1,'no automatic popup capture or retargeting');
  }else assert.equal(result.details.nextObservation,undefined,'uncertain or unrelated popup must not be recommended');
  await assert.rejects(()=>call(executeAct,params));
  assert.equal(dispatches,1,'old source state must not authorize input');
 }finally{await shutdownComputerUseSession();}
}
try {
 for(const options of [{},{wrongPid:true},{replaced:true},{unfocused:true},{hidden:true},{probeError:true},{preexisting:true},{ambiguous:true},{transportUnknown:true},{otherPlatform:true}])await scenario(options);
 console.log('Popup observation recovery passed (10 injected public-bridge scenarios)');
}finally{Object.assign(backend,original);await shutdownComputerUseSession();}
