// Public executor regression with an injected native backend; no desktop input.
import assert from 'node:assert/strict';
import {parseLookResponse} from '../src/outline.ts';
import {currentPlatformBackend as backend} from '../src/platform/index.ts';
import {executeFind,executeObserve,executeAct,shutdownComputerUseSession} from '../src/bridge.ts';
const original={...backend};
const root={kind:'window',rootRef:'native-root',windowRef:'native-root',windowId:10,pid:7,appName:'Fixture',title:'Owned fixture',zOrder:0,framePoints:{x:0,y:0,w:100,h:100},scaleFactor:1,isOnscreen:true,isFocused:true,isMinimized:false,isMain:true,isModal:false};
const other={...root,rootRef:'other-root',windowRef:'other-root',windowId:11};
const call=(fn,params)=>fn('closed-root-regression',params,undefined,undefined,{cwd:process.cwd(),hasUI:false});
async function scenario(options={}) {
 let dispatched=false,dispatches=0,postCaptures=0,probes=0;
 Object.assign(backend,{name:'windows',ensureReady:async()=>({lastPermissionCheckAt:Date.now()}),listApps:async()=>[{appName:'Fixture',pid:7}],
  listRoots:async()=>{
   if(!dispatched)return [root,other];
   probes++;
   if(options.probeError)throw Error('Identity read failed');
   return options.available || options.reappears && probes>1 ? [root,other] : [other];
  },getFrontmost:async()=>({appName:'Fixture',pid:7,windowId:10,rootRef:'native-root'}),
  observe:async()=>{if(dispatched)postCaptures++;return parseLookResponse({lookId:'fixture-look-'+postCaptures,capturedAt:Date.now()/1000,window:{windowId:10,framePoints:root.framePoints,scaleFactor:1,isModal:false},outline:{ref:'native-button',role:'button',title:'Close',canPress:true,actions:['press'],children:[]},timings:{}});},
  act:async()=>{
   dispatched=true;dispatches++;
   if(options.transportUnknown)throw Object.assign(Error('Response lost'),{code:'helper_transport_unknown',outcome:'unknown',command:'act',requestId:'request-exact',requestWriteAttempted:true});
   return {outcome:'worked',performed:{delivery:'ax'},rootDelta:[{change:'closed',kind:'window',pid:options.wrongPid?8:7,ref:options.unrelated?'other-root':'native-root',title:'Owned fixture'}]};
  },actBatch:undefined});
 try {
  const found=await call(executeFind,{text:'Owned fixture'});
  const ref=found.details.windows.find(w=>w.windowId===10).windowRef;
  const observed=await call(executeObserve,{root:ref,mode:'semantic'});
  const stateId=observed.details.capture.stateId;
  const params={stateId,observationMode:'semantic',actions:[{action:'press',ref:observed.details.outline.root.ref}]};
  if(options.condition)params.expect={text:'Close',until:options.condition,timeoutMs:100};
  const result=await call(executeAct,params);
  assert.equal(dispatches,1,'an observation failure must never replay input');
  if(!options.available&&!options.reappears&&!options.probeError&&!options.unrelated&&!options.wrongPid&&!options.transportUnknown){
   assert.equal(result.details.status,'target_closed');
   assert.equal(postCaptures,0,'confirmed closed root must not enter capture/UIA');
   assert.equal(probes,3,'bounded exact identity reconciliation is required');
   assert.equal(result.details.capture,undefined);
   assert.equal(result.details.outline,undefined);
   if(options.condition)assert.equal(result.details.execution.verification.status,options.condition==='absent'?'verified':'failed');
   await assert.rejects(()=>call(executeAct,params));
   assert.equal(dispatches,1,'closed state cannot authorize another action');
  }else if(options.transportUnknown){
   assert.equal(result.details.status,'dispatch_outcome_unknown');assert.equal(probes,0);assert.equal(postCaptures,0);
  }else{
   assert.equal(postCaptures,1,'unproven closure must preserve normal successor capture');
   assert.notEqual(result.details.status,'target_closed');
  }
 }finally{await shutdownComputerUseSession();}
}
try{
 for(const options of [{},{available:true},{reappears:true},{probeError:true},{unrelated:true,available:true},{wrongPid:true,available:true},{transportUnknown:true},{condition:'absent'},{condition:'present'}])await scenario(options);
 console.log('Closed-root capture regressions passed (9 injected native scenarios)');
}finally{Object.assign(backend,original);await shutdownComputerUseSession();}
